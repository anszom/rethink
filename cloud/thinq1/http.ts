import { Request, Response, Router } from 'express'
import { Config } from '@/util/config'
import { XMLParser, XMLBuilder, XMLValidator } from 'fast-xml-parser'
import { Metadata } from '../thinq'
import log from '@/util/logging'

const XML_HEADER = '<?xml version="1.0" encoding="utf-8" standalone="yes"?>'

const deviceMeta: Record<string, Metadata> = {}
export function getDeviceMetadata(id: string) {
    return deviceMeta[id]
}

// diagMonData is base64 of either a plain decimal string (e.g. ScomoCourse's course id) or
// XML (WasherMonitoring's tubInfo/courseInfo/energyMonInfo) — try XML first, fall back to
// the raw decoded string.
function decodeDiagMonData(b64: string): unknown {
    const raw = Buffer.from(b64, 'base64')
    if (raw[0] === 0x3c /* '<' */) {
        try {
            return new XMLParser().parse(raw)
        } catch {
            // fall through to the raw string below
        }
    }
    return raw.toString('utf-8')
}

function xmlParser(req: Request, res: Response, next: () => void) {
    const buffers: Buffer[] = []
    let length = 0
    let error = false

    req.on('data', (data) => {
        if (!error) {
            buffers.push(data)
            length += data.length
            if (length > 1000000) {
                res.status(400).end()
                error = true
            }
        }
    })

    req.on('end', () => {
        if (!error) {
            req.body = new XMLParser().parse(Buffer.concat(buffers))
            next()
        }
    })
}

export function routes(config: Config, onDiagmon?: (deviceId: string, diagMonType: string, decoded: unknown) => void) {
    const router = Router()
    router.use(xmlParser)

    router.post('/lgehadm/api/Device/TotalDeviceInfoSvc', (req, res) => {
        const response: any = {
            returnCd: '0000',
            returnMsg: 'OK',
        }

        const deviceId = req.header('x-lgedm-deviceid')
        const deviceType = req.header('x-lgedm-devicetype')
        const modelName = req.body?.lgedmRoot?.modelName
        if (!deviceId) return res.status(400).end()

        if (modelName && deviceType)
            deviceMeta[deviceId] = {
                deviceType,
                modelId: modelName,
                modelName,
            }

        if (req.body?.lgedmRoot?.itemList?.item === 'DM_SETTING_INFO_GET_URI') {
            response.itemList = {
                elementList: {
                    elementCode: 'settingInfoList',
                    elementValueList: {
                        code: 'BlackBox',
                        value: 'N',
                    },
                },
                item: 'DM_SETTING_INFO_GET_URI',
                returnCode: '0000',
            }
        } else if (req.body?.lgedmRoot?.itemList?.item === 'THINQ_TIME_SYNC_URI') {
            response.itemList = {
                elementList: [
                    {
                        elementCode: 'utcTime',
                        elementValue: new Date()
                            .toISOString()
                            .replace(/T|\....Z/g, ' ')
                            .trim(),
                    },
                    {
                        elementCode: 'timezone',
                        elementValue: 0,
                    },
                ],
                item: 'THINQ_TIME_SYNC_URI',
                returnCode: '0000',
            }
        }

        res.header('Content-type: text/xml;charset=utf-8')
        res.end(XML_HEADER + new XMLBuilder().build({ lgedmRoot: response }))
    })

    router.post('/lgehadm/api/Grid/PowerSavingInfoSvc', (req, res) => {
        res.header('Content-type: text/xml;charset=utf-8')
        res.end(XML_HEADER + new XMLBuilder().build({ lgedmRoot: { returnCd: '0108', returnMsg: 'No Saving Data.' } }))
    })

    router.post('/lgehadm/api/Rtos/FWInfoSettingSvc', (req, res) => {
        res.header('Content-type: text/xml;charset=utf-8')
        res.end(XML_HEADER + new XMLBuilder().build({ lgedmRoot: { returnCd: '0000', returnMsg: 'OK' } }))
    })

    router.post('/lgehadm/report/diagmon', (req, res) => {
        // Unlike every other lgehadm endpoint, this one doesn't send x-lgedm-deviceid - the
        // device id only exists inside the body, as Report.devId.
        const report = req.body?.Report
        const deviceId = req.header('x-lgedm-deviceid') ?? report?.devId
        if (deviceId && typeof report?.diagMonType === 'string' && typeof report?.diagMonData === 'string') {
            const decoded = decodeDiagMonData(report.diagMonData)
            log('HTTPS', `diagmon ${deviceId} ${report.diagMonType}: ${JSON.stringify(decoded)}`)
            onDiagmon?.(deviceId, report.diagMonType, decoded)
        } else {
            log('HTTPS', `diagmon ${deviceId}: ${JSON.stringify(req.body)}`)
        }
        res.end()
    })

    router.post('/api/product/sendPushMessage', (req, res) => {
        // Not yet decoded - the device's own push-notification channel (messageCode/langCode).
        // Logged so a real notification can be captured and decoded later.
        log('HTTPS', `sendPushMessage ${req.header('x-lgedm-deviceid')}: ${JSON.stringify(req.body)}`)
        res.header('Content-type: text/xml;charset=utf-8')
        res.end(XML_HEADER + new XMLBuilder().build({ lgedmRoot: { returnCd: '0000', returnMsg: 'OK' } }))
    })

    return router
}
