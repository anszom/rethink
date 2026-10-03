import { WebSocketExpress, ExtendedWebSocket } from 'websocket-express'

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import log from '@/util/logging'
import { revision } from '@/util/version'
import { reExport } from '@/management/re_export'

import HA_bridge from '@/cloud/ha_bridge'
import { AnyDevice, DeviceManager } from '@/cloud/devmgr'
import { Bridge } from '@/bridge'
import { Request, Response } from 'express'
import { Device as T1Device } from '@/cloud/thinq1/device'
import { Device as T2Device } from '@/cloud/thinq2/device'

// refresh bridged device names policy:
// - only if a websocket subscriber is connected
// - on the first subscriber's connection (but no more often than 1/minute)
// - every 15 minutes
const BRIDGE_REFRESH_NAMES_PERIOD = 1000 * 60 * 15
const BRIDGE_REFRESH_NAMES_COOLOFF = 1000 * 60
const FRAME_LIMIT = 200

type WireType = 'packet' | 'ack'
type Frame = {
    dir: 'rx' | 'tx'
    hex: string
    injected: boolean
    ts: number
    type: WireType
}

export function app(ha: HA_bridge, manager: DeviceManager, bridge: Bridge | undefined) {
    const app = new WebSocketExpress()
    const subscribers = new Set<ExtendedWebSocket>()
    const deviceMonitors = new Map<ExtendedWebSocket, () => void>()
    const disposers: Array<() => void> = []
    let shuttingDown = false
    const frames = new Map<string, Frame[]>()
    const frameHooks = new Map<string, { unhook: () => void }>()
    const injectDepth = new WeakMap<AnyDevice, number>()

    function wireHex(arg: Buffer | object) {
        return Buffer.isBuffer(arg) ? arg.toString('hex') : JSON.stringify(arg)
    }

    function pushFrame(id: string, frame: Frame) {
        let ring = frames.get(id)
        if (!ring) {
            ring = []
            frames.set(id, ring)
        }
        ring.push(frame)
        if (ring.length > FRAME_LIMIT) ring.shift()
    }

    // One listener pair per device for the life of the server, so the panel can
    // show traffic that happened before a monitor socket was opened.
    function hookDevice(dev: AnyDevice) {
        if (frameHooks.has(dev.id)) return
        const onRx = (arg: Buffer) => {
            pushFrame(dev.id, {
                dir: 'rx',
                hex: wireHex(arg),
                injected: (injectDepth.get(dev) ?? 0) > 0,
                ts: Date.now(),
                type: 'packet',
            })
        }
        const onTx = (type: WireType, arg: Buffer | object) => {
            pushFrame(dev.id, {
                dir: 'tx',
                hex: wireHex(arg),
                injected: (injectDepth.get(dev) ?? 0) > 0,
                ts: Date.now(),
                type,
            })
        }
        dev.on('data', onRx)
        dev.on('sendData', onTx)
        frameHooks.set(dev.id, {
            unhook: () => {
                dev.removeListener('data', onRx)
                dev.removeListener('sendData', onTx)
            },
        })
    }

    function unhookDevice(id: string) {
        const hook = frameHooks.get(id)
        if (!hook) return
        hook.unhook()
        frameHooks.delete(id)
    }

    function unhookAll() {
        for (const id of [...frameHooks.keys()]) unhookDevice(id)
    }

    function injected(dev: AnyDevice, fn: () => void) {
        const n = (injectDepth.get(dev) ?? 0) + 1
        injectDepth.set(dev, n)
        try {
            fn()
        } finally {
            if (n === 1) injectDepth.delete(dev)
            else injectDepth.set(dev, n - 1)
        }
    }

    function closeQuietly(ws: ExtendedWebSocket) {
        try {
            ws.close()
        } catch {}
    }

    function safeSend(ws: ExtendedWebSocket, message: string) {
        if (ws.readyState !== ws.OPEN) return false
        try {
            ws.send(message, (error) => {
                if (error) {
                    subscribers.delete(ws)
                    closeQuietly(ws)
                }
            })
            return true
        } catch {
            subscribers.delete(ws)
            closeQuietly(ws)
            return false
        }
    }

    // device management
    function broadcast(message: object) {
        const str = JSON.stringify(message)
        subscribers.forEach((sub) => safeSend(sub, str))
    }

    function statusReport(message: string) {
        broadcast({ status: message })
    }

    app.use(function (req, res, next) {
        log('MGMT', req.hostname, req.url)
        next()
    })
    app.use(WebSocketExpress.json())

    const currentDir = path.dirname(fileURLToPath(import.meta.url))
    app.ws('/ws', (req, res, next) => {
        res.accept().then((ws) => {
            if (shuttingDown) {
                closeQuietly(ws)
                return
            }

            if (subscribers.size === 0) firstSubscriberConnected()

            subscribers.add(ws)

            safeSend(
                ws,
                JSON.stringify({
                    revision,
                    ha: ha.HA.isConnected,
                    bridge: bridgeStatus(),
                    devices: enumDevices(),
                }),
            )

            ws.on('message', (msg) => {})

            ws.on('close', () => {
                subscribers.delete(ws)
                if (subscribers.size === 0) lastSubscriberDisconnected()
            })
        }, next)
    })

    const onHaStatusChanged = (ha: boolean) => {
        broadcast({ ha })
    }
    ha.HA.on('statusChanged', onHaStatusChanged)
    disposers.push(() => ha.HA.removeListener('statusChanged', onHaStatusChanged))

    function enumDevices() {
        const allDevices: Record<string, any> = {}
        for (const id in manager.allDevices) {
            const dev = manager.allDevices[id]
            const meta = dev.meta
            allDevices[id] = {
                // What the owner calls it, when the bridge has been able to ask the account
                name: bridge?.name(id),
                model: meta.modelId,
                deviceType: meta.deviceType,
                platform: dev.platform,
                mapped: dev.managed,
                bridgeState: bridge ? bridge.status(id) : 'disabled',
            }
        }
        return allDevices
    }

    function refreshDevices() {
        broadcast({ devices: enumDevices() })
    }

    function onNewDevice(dev: AnyDevice) {
        hookDevice(dev)
        refreshDevices()
    }

    function onDropDevice(id: string) {
        unhookDevice(id)
        refreshDevices()
    }

    for (const id in manager.allDevices) hookDevice(manager.allDevices[id])
    manager.on('newDevice', onNewDevice)
    manager.on('dropDevice', onDropDevice)
    disposers.push(() => {
        manager.removeListener('newDevice', onNewDevice)
        manager.removeListener('dropDevice', onDropDevice)
    })

    if (bridge) {
        app.get(
            '/thinq_login',
            asyncHandler(async (req, res) => {
                res.redirect((await bridge.beginLogin({ countryCode: req.query.countryCode as string })).toString())
            }),
        )

        app.post(
            '/thinq_login_accept',
            asyncHandler(async (req, res) => {
                const url = `${req.body.url}`
                const countryCode = `${req.body.countryCode}`
                if (await bridge.completeLogin({ countryCode }, new URL(url))) {
                    res.statusCode = 200
                    res.end()
                } else {
                    res.statusCode = 400
                    res.end()
                }
            }),
        )

        app.post(
            '/thinq_logout',
            asyncHandler(async (req, res) => {
                await bridge.logout()
                res.end()
            }),
        )

        app.post(
            '/bridge/:deviceId/enable',
            asyncHandler(async (req, res) => {
                const deviceType = typeof req.body.deviceType === 'string' ? (req.body.deviceType as string) : undefined
                try {
                    if (await bridge.enable(req.params.deviceId, deviceType, statusReport)) res.status(204).end()
                    else res.status(400).end()
                } catch (err) {
                    res.status(500).end(`${err}`)
                }
            }),
        )

        app.get(
            '/bridge/:deviceId/modeljson',
            asyncHandler(async (req, res) => {
                try {
                    const { modelName, modelJson } = await bridge.getModelJson(req.params.deviceId)
                    // the model name comes from the device, don't let it break out of the header
                    const fileName = modelName.replace(/[^A-Za-z0-9._-]/g, '_') || 'model'
                    res.setHeader('Content-Type', 'application/json')
                    res.setHeader('Content-Disposition', `attachment; filename="${fileName}.json"`)
                    res.end(modelJson)
                } catch (err) {
                    res.status(500).end(`${err}`)
                }
            }),
        )

        app.post(
            '/bridge/:deviceId/disable',
            asyncHandler(async (req, res) => {
                await bridge.disable(req.params.deviceId)
                res.status(204).end()
            }),
        )

        function refreshBridgeStatus() {
            broadcast({ bridge: bridgeStatus() })
        }

        bridge.on('loggedIn', refreshBridgeStatus)
        bridge.on('loggedOut', refreshBridgeStatus)
        bridge.on('started', refreshDevices)
        bridge.on('stopped', refreshDevices)
        bridge.on('stateChanged', refreshDevices)
        bridge.on('namesChanged', refreshDevices)
        disposers.push(() => {
            bridge.removeListener('loggedIn', refreshBridgeStatus)
            bridge.removeListener('loggedOut', refreshBridgeStatus)
            bridge.removeListener('started', refreshDevices)
            bridge.removeListener('stopped', refreshDevices)
            bridge.removeListener('stateChanged', refreshDevices)
            bridge.removeListener('namesChanged', refreshDevices)
        })
    }

    function bridgeStatus() {
        if (!bridge) return { disabled: true }
        return { loggedIn: bridge.isLoggedIn() }
    }

    let refreshNamesTimer: ReturnType<typeof setInterval> | undefined
    let lastNamesRefresh: number | undefined

    // device name list refresh
    function firstSubscriberConnected() {
        function maybeRefreshNames() {
            const now = Date.now()
            if (lastNamesRefresh && now - lastNamesRefresh < BRIDGE_REFRESH_NAMES_COOLOFF) return

            void bridge?.refreshNames()
            lastNamesRefresh = Date.now()
        }

        if (bridge) {
            maybeRefreshNames()
            refreshNamesTimer = setInterval(() => maybeRefreshNames(), BRIDGE_REFRESH_NAMES_PERIOD)
        }
    }

    function lastSubscriberDisconnected() {
        if (refreshNamesTimer) clearInterval(refreshNamesTimer)
        refreshNamesTimer = undefined
    }

    // Panel workbench: recent frames, identity, and the decode button.
    app.get('/api/devices/:deviceId/frames', (req, res) => {
        const id = req.params.deviceId
        const list = frames.get(id) ?? []
        res.json({ ok: true, deviceId: id, count: list.length, frames: list })
    })

    app.get('/api/devices/:deviceId', (req, res) => {
        const id = req.params.deviceId
        const dev = manager.allDevices[id]
        if (!dev) {
            res.status(404).json({ ok: false, error: 'device not connected' })
            return
        }
        const state = bridge ? bridge.status(id) : 'disabled'
        res.json({
            ok: true,
            id,
            platform: dev.platform,
            modelId: dev.meta.modelId,
            modelName: dev.meta.modelName,
            deviceType: dev.meta.deviceType,
            swVersion: dev.meta.swVersion,
            mapped: dev.managed,
            bridged: state === 'online' || state === 'offline',
            haConnected: ha.HA.isConnected,
            name: bridge?.name(id),
        })
    })

    app.post('/api/re/export', (req, res) => {
        const out = reExport(req.body ?? {})
        res.status(out.ok ? 200 : 400).json(out)
    })

    // device monitoring
    app.ws('/device', (req, res, next) => {
        const id = req.query?.id
        if (typeof id !== 'string') {
            res.status(400).end()
            return
        }

        res.accept().then((ws) => {
            if (shuttingDown) {
                closeQuietly(ws)
                return
            }
            let injectFlag = false
            let device: AnyDevice | undefined
            const onDeviceRx = (arg: Buffer) => {
                safeSend(
                    ws,
                    JSON.stringify({
                        rx: arg.toString('hex'),
                        injected: injectFlag,
                        ts: Date.now(),
                        type: 'packet',
                    }),
                )
            }

            const onDeviceTx = (type: 'packet' | 'ack', arg: Buffer | object) => {
                const tx = Buffer.isBuffer(arg) ? arg.toString('hex') : JSON.stringify(arg)
                safeSend(ws, JSON.stringify({ tx, injected: injectFlag, ts: Date.now(), type }))
            }

            const prior = frames.get(id)
            if (prior && prior.length) {
                safeSend(
                    ws,
                    JSON.stringify({
                        history: prior.map((f) => ({
                            [f.dir]: f.hex,
                            injected: f.injected,
                            ts: f.ts,
                            type: f.type,
                        })),
                        count: prior.length,
                    }),
                )
            }

            const checkDevicePresence = () => {
                const dev = manager.allDevices[id]

                if (dev !== device) {
                    device?.removeListener('data', onDeviceRx)
                    device?.removeListener('sendData', onDeviceTx)

                    device = dev
                    if (device) {
                        safeSend(ws, JSON.stringify({ status: 'online', meta: device.meta }))
                        device.on('data', onDeviceRx)
                        device.on('sendData', onDeviceTx)
                    } else {
                        safeSend(ws, JSON.stringify({ status: 'offline' }))
                    }
                }
            }

            manager.on('newDevice', checkDevicePresence)
            manager.on('dropDevice', checkDevicePresence)

            checkDevicePresence()

            ws.on('message', (msg) => {
                if (!Buffer.isBuffer(msg)) return

                let json: any
                try {
                    json = JSON.parse(msg.toString('utf-8'))
                } catch {
                    return
                }
                const dev = manager.allDevices[id]

                try {
                    injectFlag = true
                    if (typeof json.sendToDevice === 'object' && dev && dev instanceof T1Device) {
                        injected(dev, () => dev.send(json.sendToDevice))
                    }

                    if (typeof json.sendToDevice === 'string' && dev && dev instanceof T2Device) {
                        injected(dev, () => dev.send_packet(Buffer.from(json.sendToDevice, 'hex')))
                    }

                    if (json.sendFromDevice && dev) {
                        injected(dev, () => dev.emit('data', Buffer.from(json.sendFromDevice, 'hex')))
                    }
                } catch (err) {
                    log('MGMT', id, `inject error: ${err}`)
                } finally {
                    injectFlag = false
                }
            })

            const cleanup = () => {
                if (!deviceMonitors.delete(ws)) return
                device?.removeListener('data', onDeviceRx)
                device?.removeListener('sendData', onDeviceTx)
                device = undefined
                manager.removeListener('newDevice', checkDevicePresence)
                manager.removeListener('dropDevice', checkDevicePresence)
            }
            deviceMonitors.set(ws, cleanup)
            ws.once('close', cleanup)
            ws.once('error', cleanup)
        }, next)
    })

    // The panel badge is a placeholder in the static file. Fill it from the same
    // revision the status socket already reports.
    const sendPanel = (_req: Request, res: Response) => {
        const html = fs
            .readFileSync(path.join(currentDir, '../html/index.html'), 'utf8')
            .replaceAll('__RETHINK_GIT_SHA__', revision)
        res.type('html').send(html)
    }
    app.get('/', sendPanel)
    app.get('/index.html', sendPanel)

    // static pages
    app.use(WebSocketExpress.static(currentDir + '/../html', { extensions: ['html'] }))
    const server = app.createServer()

    const dispose = () => {
        if (shuttingDown) return
        shuttingDown = true
        unhookAll()
        for (const dispose of disposers.splice(0)) dispose()
        for (const subscriber of subscribers) closeQuietly(subscriber)
        subscribers.clear()
        for (const [monitor, cleanup] of deviceMonitors) {
            cleanup()
            closeQuietly(monitor)
        }
        deviceMonitors.clear()
        lastSubscriberDisconnected()
    }

    const close = server.close.bind(server)
    server.close = ((callback?: (err?: Error) => void) => {
        dispose()
        return close(callback)
    }) as typeof server.close
    server.once('close', dispose)
    return server
}

function asyncHandler(handler: (req: Request, res: Response) => Promise<any>) {
    return (req: Request, res: Response, next: (err: any) => void) => {
        handler(req, res).catch(next)
    }
}
