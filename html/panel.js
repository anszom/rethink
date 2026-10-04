/**
 * ThinQ deviceType codes → short labels (wideq DeviceType + rethink research).
 * Display always as "Name (code)" when known.
 */
const DEVICE_TYPE_NAMES = {
    101: 'Refrigerator',
    102: 'Kimchi Refrigerator',
    103: 'Water Purifier',
    201: 'Washer',
    202: 'Dryer',
    203: 'Styler',
    204: 'Dishwasher',
    221: 'WashTower',
    222: 'WashTower',
    223: 'WashTower',
    301: 'Oven / Range',
    302: 'Microwave',
    303: 'Cooktop',
    304: 'Range Hood',
    401: 'A/C',
    402: 'Air Purifier',
    403: 'Dehumidifier',
    404: 'Humidifier',
    501: 'Robot Vacuum',
    504: 'Vacuum',
    1001: 'ARCH',
    3001: 'MISSG',
    3002: 'Sensor',
    3003: 'IoT Lighting',
    3004: 'IoT Motion Sensor',
    3005: 'IoT Smart Plug',
    3006: 'IoT Dust Sensor',
    3102: 'Solar Sensor',
    4001: 'EMS Air Station',
    4003: 'Air Sensor',
}

/** Extract bare deviceType code from raw or already-formatted values. */
function deviceTypeCode(raw) {
    if (raw == null || raw === '' || raw === '—') return null
    const s = String(raw).trim()
    const paren = s.match(/\((\d{3,4})\)\s*$/)
    if (paren) return paren[1]
    const lead = s.match(/^(\d{3,4})\b/)
    if (lead) return lead[1]
    return null
}

/**
 * Format device type for UI: "A/C (401)" when known, else bare code or —.
 * @param {string|number|null|undefined} raw
 */
function formatDeviceType(raw) {
    if (raw == null || raw === '' || raw === '—') return '—'
    const code = deviceTypeCode(raw)
    if (!code) return String(raw).trim()
    const name = DEVICE_TYPE_NAMES[code] || DEVICE_TYPE_NAMES[Number(code)]
    if (name) return `${name} (${code})`
    return code
}

function deviceTypeAutocompleteData() {
    const data = {}
    for (const [code, name] of Object.entries(DEVICE_TYPE_NAMES)) {
        data[`${code} (${name})`] = null
        data[`${name} (${code})`] = null
    }
    return data
}

document.addEventListener('DOMContentLoaded', function () {
    M.Tooltip.init(document.querySelectorAll('.tooltipped'))
    M.Modal.init(document.querySelectorAll('.modal'))
    M.Autocomplete.init(document.querySelectorAll('.autocomplete'), {
        data: deviceTypeAutocompleteData(),
    })
})

const STATUS_OK = `<i class="tiny material-icons" style="color:#3dd68c">check</i>`
const STATUS_ERROR = `<i class="tiny material-icons" style="color:#f07178">error</i>`
const STATUS_UNKNOWN = `<i class="tiny material-icons" style="color:#8b9bb0">question_mark</i>`
// Not an error: the bridge was left out of the configuration on purpose.
const STATUS_DISABLED = `<i class="tiny material-icons" style="color:#8b9bb0">block</i>`

let ws
let deviceWs
let reconnectTimer
let deviceReconnectTimer
let bridge_status = false
let selectedDeviceId = null
/** @type {HTMLElement[]} ordered multi-selection (A, B, …) */
let selectedFrames = []
/** Anchor for shift+click range */
let frameSelectAnchor = null
/** Last decode result (for spans / hover) */
let lastDecode = null

const devices = {}
const baseUrl = new URL(window.location)
baseUrl.search = ''
baseUrl.hash = ''

get('status_rethink').innerHTML = STATUS_UNKNOWN
get('status_mqtt').innerHTML = STATUS_UNKNOWN
get('status_bridge').innerHTML = STATUS_UNKNOWN
get('status_bridge_text').innerText = 'Unknown'

function get(id) {
    return document.getElementById(id)
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
}

function shortId(id) {
    if (!id || id.length <= 14) return id || ''
    return id.slice(0, 6) + '…' + id.slice(-4)
}

// ── Device table ──────────────────────────────────────────────────────────

class DeviceEntry {
    constructor(id, remoteState, parent) {
        this.id = id
        this.remoteState = remoteState
        this.row = document.createElement('tr')
        this.row.title = id
        parent.appendChild(this.row)
        this.updateDom()
    }

    destroy() {
        this.row.remove()
    }

    update(remoteState) {
        this.remoteState = remoteState
        this.updateDom()
    }

    updateDom() {
        const model = this.remoteState.model || '—'
        const platform = this.remoteState.platform || '—'
        const haChip = this.remoteState.mapped
            ? `<span class="chip chip-mapped">mapped</span>`
            : `<span class="chip chip-unmapped">raw</span>`

        const dtype = formatDeviceType(this.remoteState.deviceType)
        this.row.innerHTML = `
            <td class="col-model">
                <div>${escapeHtml(model)}${
                    this.remoteState.mapped
                        ? ''
                        : ' <i class="material-icons tooltipped tiny" data-tooltip="Not mapped to HA" style="color:#f0b429;font-size:14px;vertical-align:middle">warning</i>'
                }</div>
                <div class="id-sub">${escapeHtml(shortId(this.id))}${
                    dtype !== '—' ? ' · ' + escapeHtml(dtype) : ''
                }</div>
            </td>
            <td class="col-plat">${escapeHtml(platform)}</td>
            <td class="col-ha">${haChip}</td>
            <td class="col-bridge">
                <div class="switch" style="display:inline-block">
                    <label>Off <input type="checkbox"> <span class="lever"></span> On</label>
                </div>
                <div class="hide preloader-wrapper verysmall active" style="vertical-align:middle">
                    <div class="spinner-layer spinner-green-only">
                        <div class="circle-clipper left"><div class="circle"></div></div>
                        <div class="gap-patch"><div class="circle"></div></div>
                        <div class="circle-clipper right"><div class="circle"></div></div>
                    </div>
                </div>
            </td>`

        this.bridgeSwitch = this.row.querySelector('input[type=checkbox]')
        this.bridgeDiv = this.row.querySelector('.switch')
        this.spinner = this.row.querySelector('.preloader-wrapper')

        // Whole-row select (except bridge switch)
        this.row.onclick = (ev) => {
            if (ev.target.closest('.switch') || ev.target.closest('input') || ev.target.closest('.lever')) {
                return
            }
            selectDevice(this.id)
        }

        const startBridge = async (deviceType) => {
            this.bridgeBusy = true
            this.refreshUI()
            try {
                await fetchWrapper(`bridge/${this.id}/enable`, { deviceType }, { method: 'POST' })
                this.remoteState.bridged = true
            } finally {
                this.bridgeBusy = false
                this.refreshUI()
            }
        }
        const stopBridge = async () => {
            this.bridgeBusy = true
            this.refreshUI()
            try {
                await fetchWrapper(`bridge/${this.id}/disable`, {}, { method: 'POST' })
                this.remoteState.bridged = false
            } finally {
                this.bridgeBusy = false
                this.refreshUI()
            }
        }

        this.bridgeSwitch.onchange = (ev) => {
            ev.stopPropagation()
            if (this.bridgeSwitch.checked) {
                if (this.remoteState.deviceType) {
                    startBridge(this.remoteState.deviceType)
                } else {
                    get('btn_devicetype_continue').onclick = () => {
                        let devType = get('devtype-input').value
                        // Accept "401", "401 (A/C)", or "A/C (401)"
                        devType = deviceTypeCode(devType) || String(devType).split(/\s+/)[0]
                        startBridge(devType)
                        M.Modal.getInstance(get('devicetype_query')).close()
                    }
                    M.Modal.getInstance(get('devicetype_query')).open()
                }
            } else {
                stopBridge()
            }
        }
        this.bridgeSwitch.onclick = (ev) => ev.stopPropagation()

        Array.from(this.row.getElementsByClassName('tooltipped')).forEach((e) => M.Tooltip.init(e))
        this.refreshUI()
        this.row.classList.toggle('selected', selectedDeviceId === this.id)
    }

    refreshUI() {
        if (!this.bridgeSwitch) return
        if (this.bridgeBusy) {
            this.bridgeDiv.classList.add('hide')
            this.spinner.classList.remove('hide')
        } else {
            this.spinner.classList.add('hide')
            this.bridgeDiv.classList.remove('hide')
            const state = this.remoteState.bridgeState
            const enabled = state === 'online' || state === 'offline'
            this.bridgeSwitch.checked = state == null ? !!this.remoteState.bridged : enabled
        }
        this.bridgeSwitch.disabled = !bridge_status
    }
}

function updateDevicesEmpty() {
    const empty = get('devices_empty')
    if (!empty) return
    if (Object.keys(devices).length === 0) empty.classList.remove('hide')
    else empty.classList.add('hide')
}

// ── Select device → monitor + decode ──────────────────────────────────────

function renderDetailBar(data, fallbackId) {
    const bar = get('detail_bar')
    if (!bar) return
    const fields = [
        ['ID', data.id || fallbackId || '—'],
        ['Model', data.modelId || data.model || '—'],
        ['Name', data.modelName || '—'],
        ['Platform', data.platform || '—'],
        ['Device type', formatDeviceType(data.deviceType)],
        ['SW version', data.swVersion || '—'],
        ['HA mapped', data.mapped === true ? 'yes' : data.mapped === false ? 'no' : '—'],
        ['Bridged', data.bridged === true ? 'yes' : data.bridged === false ? 'no' : '—'],
        ['HA MQTT', data.haConnected === true ? 'connected' : data.haConnected === false ? 'disconnected' : '—'],
    ]
    bar.innerHTML = fields
        .map(
            ([k, v]) =>
                `<div class="di"><label>${escapeHtml(k)}</label><span title="${escapeHtml(
                    String(v),
                )}">${escapeHtml(String(v))}</span></div>`,
        )
        .join('')
}

async function selectDevice(id) {
    selectedDeviceId = id
    for (const d of Object.values(devices)) {
        d.row.classList.toggle('selected', d.id === id)
    }

    const wb = get('workbench')
    wb.classList.add('active')

    const local = devices[id]
    const model = (local && local.remoteState.model) || ''
    get('decode_model').value = model
    get('device_meta').textContent = `${model || '—'} · ${id}`
    get('device_status').textContent = 'connecting…'
    get('decode_source').textContent = ''
    renderDetailBar(
        {
            id,
            modelId: model,
            platform: local && local.remoteState.platform,
            deviceType: local && local.remoteState.deviceType,
            mapped: local && local.remoteState.mapped,
            bridged: local && local.remoteState.bridged,
        },
        id,
    )

    clearFrames()
    connectDeviceWs(id)

    // REST history (also arrives via WS history message)
    try {
        const res = await fetch(`${baseUrl}api/devices/${encodeURIComponent(id)}/frames`)
        const data = await res.json()
        if (data.ok && Array.isArray(data.frames) && data.frames.length) {
            // Only seed if WS history hasn't already filled the list
            if (get('messages').childElementCount === 0) {
                for (const f of data.frames) {
                    pushFrame(f.dir || 'rx', f.hex, f.injected, f.ts, true, f.type)
                }
            }
        }
    } catch (_) {
        /* ignore */
    }

    try {
        const res = await fetch(`${baseUrl}api/devices/${encodeURIComponent(id)}`)
        const data = await res.json()
        if (data.ok) {
            get('device_meta').textContent = `${data.modelId || model} · ${data.platform || ''} · ${
                data.mapped ? 'HA mapped' : 'unmapped'
            } · ${data.bridged ? 'bridged' : 'local'}`
            if (data.modelId) get('decode_model').value = data.modelId
            renderDetailBar(data, id)
        }
    } catch (_) {
        /* ignore */
    }
}

function deviceSocketUrl(id) {
    const url = new URL('device', baseUrl)
    url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    url.search = `?id=${encodeURIComponent(id)}`
    return url
}

function connectDeviceWs(id) {
    clearTimeout(deviceReconnectTimer)
    if (deviceWs) {
        deviceWs.onclose = deviceWs.onopen = deviceWs.onmessage = null
        try {
            deviceWs.close()
        } catch (_) {}
        deviceWs = null
    }

    let retry = 250
    const open = () => {
        if (selectedDeviceId !== id) return
        deviceWs = new WebSocket(deviceSocketUrl(id))
        deviceWs.onopen = () => {
            retry = 250
            get('device_status').textContent = 'waiting…'
        }
        deviceWs.onclose = () => {
            if (selectedDeviceId !== id) return
            get('device_status').textContent = 'reconnecting…'
            setInjectEnabled(false)
            deviceReconnectTimer = setTimeout(open, retry)
            retry = 5000
        }
        deviceWs.onmessage = (ev) => {
            if (selectedDeviceId !== id) return
            if (typeof ev.data !== 'string') return
            let json
            try {
                json = JSON.parse(ev.data)
            } catch {
                return
            }
            if (Array.isArray(json.history)) {
                // Prefer server history as baseline if list empty or only partial
                clearFrames()
                for (const f of json.history) {
                    const dir = f.rx != null ? 'rx' : 'tx'
                    const hex = f.rx != null ? f.rx : typeof f.tx === 'string' ? f.tx : JSON.stringify(f.tx)
                    pushFrame(dir, hex, f.injected, f.ts, true, f.type)
                }
            }
            if (json.rx != null) {
                const hex = typeof json.rx === 'string' ? json.rx : JSON.stringify(json.rx)
                pushFrame('rx', hex, json.injected, json.ts, false, json.type)
            }
            if (json.tx != null) {
                const hex = typeof json.tx === 'string' ? json.tx : JSON.stringify(json.tx)
                pushFrame('tx', hex, json.injected, json.ts, false, json.type)
            }
            if (json.status) {
                get('device_status').textContent = json.status
                setInjectEnabled(json.status === 'online')
            }
            if (json.meta && json.meta.modelId) {
                get('decode_model').value = json.meta.modelId
            }
        }
    }
    open()
}

function setInjectEnabled(on) {
    get('btn_send_to').disabled = !on
    get('btn_send_from').disabled = !on
}

function clearFrames() {
    get('messages').innerHTML = ''
    selectedFrames = []
    frameSelectAnchor = null
    updateDiffBanner()
    clearPayloadHighlight()
}

get('btn_clear_frames')?.addEventListener('click', clearFrames)

function formatTs(ts) {
    if (ts) {
        try {
            return new Date(Number(ts) || ts).toLocaleTimeString()
        } catch (_) {}
    }
    return new Date().toLocaleTimeString()
}

function parseTsMs(el) {
    const t = el && el.dataset.ts
    if (!t) return null
    const n = Number(t)
    return Number.isFinite(n) ? n : null
}

/** CLIP JSON from rethink handlers (setMaskingInfo, etc.) — not UART TLV hex. */
function isClipJsonPayload(s) {
    const t = String(s).trim()
    if (!t.startsWith('{')) return false
    try {
        const o = JSON.parse(t)
        return o && typeof o === 'object' && (o.cmd != null || o.type != null || o.data != null)
    } catch {
        return false
    }
}

function clipSummary(s) {
    try {
        const o = JSON.parse(s)
        const cmd = o.cmd || '?'
        const typ = o.type != null ? o.type : ''
        const data =
            o.data != null
                ? typeof o.data === 'string'
                    ? o.data
                    : JSON.stringify(o.data)
                : ''
        return `CLIP ${cmd}${typ !== '' ? ' type=' + typ : ''}${data ? ' ' + data : ''}`
    } catch {
        return s
    }
}

function pushFrame(dir, payload, injected, ts, fromHistory, type) {
    const messages = get('messages')
    const div = document.createElement('div')
    const raw = String(payload)
    const clip = isClipJsonPayload(raw)
    const tsMs = ts != null ? Number(ts) : Date.now()
    div.className = `frame ${dir}${clip ? ' clip' : ''}${injected ? ' injected' : ''}`
    div.dataset.payload = raw
    div.dataset.dir = dir
    div.dataset.kind = clip ? 'clip' : 'hex'
    div.dataset.ts = String(tsMs)
    div.dataset.type = type || 'packet'
    const label = clip ? clipSummary(raw) : raw
    const show = label.length > 200 ? label.slice(0, 200) + '…' : label
    const typeLabel =
        type && type !== 'packet' ? `<span class="typeLabel">${escapeHtml(type)}</span>` : ''
    div.innerHTML = `<span class="ts">${escapeHtml(formatTs(tsMs))}</span><span class="dir">${
        clip ? 'clip' : dir
    }</span>${typeLabel}${escapeHtml(show)}`
    div.addEventListener('click', (ev) => onFrameClick(ev, div))
    messages.appendChild(div)
    if (!fromHistory && get('autoscroll').checked) {
        messages.scrollTop = messages.scrollHeight
    }
    return div
}

function allFrameEls() {
    return Array.from(get('messages').querySelectorAll('.frame'))
}

function paintFrameSelection() {
    allFrameEls().forEach((el) => {
        el.classList.remove('selected', 'selected-a', 'selected-b')
    })
    selectedFrames.forEach((el, i) => {
        el.classList.add('selected')
        if (selectedFrames.length >= 2) {
            if (i === 0) el.classList.add('selected-a')
            else if (i === selectedFrames.length - 1) el.classList.add('selected-b')
        }
    })
    updateDiffBanner()
}

function framesInTimeOrder(els) {
    return [...els].sort((a, b) => {
        const ta = parseTsMs(a) ?? 0
        const tb = parseTsMs(b) ?? 0
        if (ta !== tb) return ta - tb
        // stable: DOM order as tie-breaker
        const all = allFrameEls()
        return all.indexOf(a) - all.indexOf(b)
    })
}

function updateDiffBanner() {
    const b = get('diff_banner')
    if (!b) return
    if (selectedFrames.length === 0) {
        b.textContent = ''
    } else if (selectedFrames.length === 1) {
        b.textContent = '1 frame · Ctrl/⌘+click multi · Shift+click range'
    } else {
        const ordered = framesInTimeOrder(selectedFrames)
        const ta = parseTsMs(ordered[0])
        const tb = parseTsMs(ordered[ordered.length - 1])
        const dt = ta != null && tb != null ? Math.abs(tb - ta) : null
        const rx = ordered.filter((e) => e.dataset.dir === 'rx').length
        const tx = ordered.filter((e) => e.dataset.dir === 'tx').length
        b.textContent = `${ordered.length} frames (rx=${rx} tx=${tx}) · span ${
            dt != null ? dt + ' ms' : '?'
        } · full sequence in text breakdown`
    }
}

function onFrameClick(ev, el) {
    ev.preventDefault()
    const multi = ev.ctrlKey || ev.metaKey
    const range = ev.shiftKey
    const frames = allFrameEls()

    if (range && frameSelectAnchor) {
        const i0 = frames.indexOf(frameSelectAnchor)
        const i1 = frames.indexOf(el)
        if (i0 >= 0 && i1 >= 0) {
            const lo = Math.min(i0, i1)
            const hi = Math.max(i0, i1)
            selectedFrames = frames.slice(lo, hi + 1)
        } else {
            selectedFrames = [el]
            frameSelectAnchor = el
        }
    } else if (multi) {
        const idx = selectedFrames.indexOf(el)
        if (idx >= 0) selectedFrames.splice(idx, 1)
        else selectedFrames.push(el)
        frameSelectAnchor = el
    } else {
        selectedFrames = [el]
        frameSelectAnchor = el
    }

    paintFrameSelection()

    if (selectedFrames.length >= 2) {
        runMultiFrameBreakdown(framesInTimeOrder(selectedFrames))
    } else if (selectedFrames.length === 1) {
        loadFrameIntoDecoder(selectedFrames[0])
    }
}

function loadFrameIntoDecoder(el) {
    const payload = el.dataset.payload || ''
    const dir = el.dataset.dir || 'rx'
    const kind = el.dataset.kind || 'hex'

    get('decode_hex').value = payload
    renderPayloadView(payload, null)
    get('decode_direction').value = dir === 'tx' ? 'toDevice' : 'fromDevice'
    get('decode_source').textContent =
        kind === 'clip' ? `CLIP JSON · ${dir}` : `${dir} · ${payload.length} hex chars`

    if (get('auto_decode').checked) {
        if (kind === 'clip') {
            renderClipBreakdown(payload)
        } else {
            runDecode()
        }
    }
}

function renderClipBreakdown(payload) {
    lastDecode = null
    let pretty = payload
    let cmd = '?'
    try {
        const body = JSON.parse(payload)
        pretty = JSON.stringify(body, null, 2)
        cmd = body.cmd || '?'
    } catch (_) {}

    get('tlv_body').innerHTML = `<tr><td colspan="4" class="empty-state">
        Not a UART/TLV frame — ThinQ2 <b>CLIP</b> command from rethink (device handler → cloud MQTT).
    </td></tr>`
    get('decode_summary').innerHTML =
        `kind=<b>CLIP</b> · cmd=<b>${escapeHtml(String(cmd))}</b> · skip TLV decode`
    get('text_breakdown').value =
        `# ThinQ CLIP command (not TLV)\n` +
        `Source: rethink device handler → MQTT CLIP (cmd/type/data)\n\n` +
        pretty
    renderPayloadView(payload, null)
}

// ── Payload hex view + tag hover highlight ────────────────────────────────

function clearPayloadHighlight() {
    const view = get('payload_view')
    if (!view) return
    view.querySelectorAll('.hex-byte.hl').forEach((n) => n.classList.remove('hl'))
}

function renderPayloadView(hexStr, highlightRange) {
    const view = get('payload_view')
    if (!view) return
    const hex = String(hexStr || '')
        .replace(/[^0-9a-fA-F]/g, '')
        .toLowerCase()
    if (!hex) {
        view.innerHTML = '<span class="empty-state">Select a frame…</span>'
        return
    }
    // Pair into bytes
    const parts = []
    for (let i = 0; i < hex.length; i += 2) {
        const byteIndex = i / 2
        const pair = hex.slice(i, i + 2)
        let cls = 'hex-byte'
        if (
            highlightRange &&
            byteIndex >= highlightRange[0] &&
            byteIndex < highlightRange[1]
        ) {
            cls += ' hl'
        }
        parts.push(`<span class="${cls}" data-bi="${byteIndex}">${pair}</span>`)
    }
    view.innerHTML = parts.join('')
}

function highlightPayloadBytes(byteStart, byteEnd) {
    const view = get('payload_view')
    if (!view) return
    view.querySelectorAll('.hex-byte').forEach((n) => {
        const bi = Number(n.dataset.bi)
        n.classList.toggle('hl', bi >= byteStart && bi < byteEnd)
    })
}

// ── Multi-frame delta ─────────────────────────────────────────────────────

async function decodePayloadSilent(payload, dir) {
    if (isClipJsonPayload(payload)) {
        return { kind: 'clip', payload, dir }
    }
    const direction = dir === 'tx' ? 'toDevice' : 'fromDevice'
    const model_id = get('decode_model').value || undefined
    const res = await fetch(`${baseUrl}api/re/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hex: payload, direction, model_id }),
    })
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || 'decode failed')
    return { kind: 'hex', dir, decode: data.decode, text: data.text }
}

function tagMapFromDecode(dec) {
    const map = new Map()
    const els = (dec && dec.elements) || []
    for (const e of els) {
        map.set(e.t, e)
    }
    return map
}

/** Device identity for RE paste context (from detail bar / selection). */
function deviceContextLines() {
    const id = selectedDeviceId || '—'
    const model = (get('decode_model') && get('decode_model').value) || '—'
    let platform = '—'
    let deviceType = '—'
    let mapped = '—'
    let bridged = '—'
    if (selectedDeviceId && devices[selectedDeviceId]) {
        const s = devices[selectedDeviceId].remoteState || {}
        platform = s.platform || platform
        deviceType = s.deviceType != null ? s.deviceType : deviceType
        mapped = s.mapped === true ? 'yes' : s.mapped === false ? 'no' : mapped
        bridged = s.bridged === true ? 'yes' : s.bridged === false ? 'no' : bridged
    }
    const bar = get('detail_bar')
    if (bar) {
        const grab = (label) => {
            const labs = bar.querySelectorAll('.di label')
            for (const lab of labs) {
                if (lab.textContent.trim().toLowerCase() === label.toLowerCase()) {
                    const span = lab.parentElement && lab.parentElement.querySelector('span')
                    return span ? span.textContent.trim() : null
                }
            }
            return null
        }
        platform = grab('Platform') || platform
        deviceType = grab('Device type') || deviceType
        mapped = grab('HA mapped') || mapped
        bridged = grab('Bridged') || bridged
        const name = grab('Name')
        const mid = grab('Model')
        return {
            id: grab('ID') || id,
            modelId: mid && mid !== '—' ? mid : model,
            modelName: name || '—',
            platform,
            // Prefer bare code for paste exports; label is recoverable via formatDeviceType
            deviceType: deviceTypeCode(deviceType) || deviceType,
            deviceTypeLabel: formatDeviceType(deviceType),
            mapped,
            bridged,
        }
    }
    return {
        id,
        modelId: model,
        modelName: '—',
        platform,
        deviceType: deviceTypeCode(deviceType) || deviceType,
        deviceTypeLabel: formatDeviceType(deviceType),
        mapped,
        bridged,
    }
}

/** Pull kind/b5/b6/b7/len from decode notes when present. */
function parseEnvelopeNotes(notes) {
    const joined = (notes || []).join(' ')
    const kind = joined.match(/\bkind=0x([0-9a-f]+)\b/i)
    if (!kind) return null
    const b5 = joined.match(/\bb5=0x([0-9a-f]+)\b/i)
    const b6 = joined.match(/\bb6=0x([0-9a-f]+)\b/i)
    const b7 = joined.match(/\bb7=0x([0-9a-f]+)\b/i)
    const len = joined.match(/\blen=(\d+)\b/i)
    return {
        kind: parseInt(kind[1], 16),
        b5: b5 ? parseInt(b5[1], 16) : null,
        b6: b6 ? parseInt(b6[1], 16) : null,
        b7: b7 ? parseInt(b7[1], 16) : null,
        len: len ? Number(len[1]) : null,
    }
}

/** Stable signature of TLV payload (order-preserving) for same-as collapse. */
function tagSignature(els) {
    if (!els || !els.length) return '__empty__'
    return els.map((e) => `${e.t}=${e.v}`).join('|')
}

function formatOneTag(e) {
    const hx = '0x' + Number(e.t).toString(16).padStart(3, '0')
    if (e.known) return `${hx}:${e.name || '?'}=${e.v}`
    return `${hx}:UNKNOWN=${e.v}`
}

/**
 * Detect fan-table triple starting at idx.
 * Wire order varies: mode,pad,fan (0x2d7/2d8/2d9) or mode,fan,pad (0x2d7/2d9/2d8).
 * @returns {{ mode: number, pad: number, fan: number }|null}
 */
function parseFanTableRow(els, idx) {
    if (idx + 2 >= els.length) return null
    if (Number(els[idx].t) !== 0x2d7) return null
    const t1 = Number(els[idx + 1].t)
    const t2 = Number(els[idx + 2].t)
    if (t1 === 0x2d8 && t2 === 0x2d9) {
        return { mode: els[idx].v, pad: els[idx + 1].v, fan: els[idx + 2].v }
    }
    if (t1 === 0x2d9 && t2 === 0x2d8) {
        return { mode: els[idx].v, fan: els[idx + 1].v, pad: els[idx + 2].v }
    }
    return null
}

/**
 * Compact tag list: collapse consecutive fan-table triples into one line.
 * @returns {string[]} lines (no trailing blank)
 */
function formatTagsCompact(els) {
    if (!els || !els.length) return ['tags: (none)']
    const out = []
    const singles = []
    const flushSingles = () => {
        if (!singles.length) return
        out.push(...singles)
        singles.length = 0
    }
    let i = 0
    while (i < els.length) {
        const row0 = parseFanTableRow(els, i)
        if (row0) {
            flushSingles()
            const rows = []
            while (parseFanTableRow(els, i)) {
                const r = parseFanTableRow(els, i)
                rows.push(`(${r.mode},${r.pad},${r.fan})`)
                i += 3
            }
            out.push(`fan_table[${rows.length}] mode,pad,fan: ${rows.join(' ')}`)
        } else {
            singles.push(formatOneTag(els[i]))
            i++
        }
    }
    flushSingles()

    const hasGroup = out.some((l) => l.startsWith('fan_table'))
    if (!hasGroup) {
        if (out.length <= 8) return [`tags: ${out.join(' ')}`]
        return ['tags:', ...out.map((l) => `  ${l}`)]
    }
    const plain = out.filter((l) => !l.startsWith('fan_table'))
    const groups = out.filter((l) => l.startsWith('fan_table'))
    const lines = ['tags:']
    if (plain.length) {
        if (plain.length <= 6) lines.push(`  ${plain.join(' ')}`)
        else for (const p of plain) lines.push(`  ${p}`)
    }
    for (const g of groups) lines.push(`  ${g}`)
    return lines
}

/**
 * Compact one-frame block for multi-frame transcripts (no nested full exports).
 * @param {number|string} index 1-based
 * @param {Map<string, number>|null} sigFirstIndex map of tag/clip sig → first frame index
 * @returns {{ lines: string[], tagSig: string|null }}
 */
function formatFrameCompact(index, decoded, payload, dir, ts, t0, sigFirstIndex) {
    const lines = []
    const kind = decoded.kind || (isClipJsonPayload(payload) ? 'clip' : 'hex')
    const iso = ts != null ? new Date(ts).toISOString() : '?'
    const rel = t0 != null && ts != null ? `+${ts - t0}ms` : ''
    const direction = dir === 'tx' ? 'toDevice' : dir === 'rx' ? 'fromDevice' : dir
    const hex =
        kind === 'hex' && decoded.decode && decoded.decode.hex
            ? decoded.decode.hex
            : String(payload || '')
                  .replace(/[^0-9a-fA-F]/g, '')
                  .toLowerCase() || payload

    const head = [`#${index}`, dir.toUpperCase(), direction, rel || iso].filter(Boolean).join(' ')
    lines.push(`### ${head}`)

    if (kind === 'clip') {
        lines.push('protocol=CLIP')
        let clipBody = payload
        try {
            clipBody = JSON.stringify(JSON.parse(payload))
        } catch {
            /* keep raw */
        }
        const clipSig = `clip:${clipBody}`
        if (sigFirstIndex && sigFirstIndex.has(clipSig)) {
            lines.push(`payload: (same as #${sigFirstIndex.get(clipSig)})`)
        } else {
            lines.push(`payload: ${clipBody}`)
            if (sigFirstIndex) sigFirstIndex.set(clipSig, index)
        }
        lines.push('')
        return { lines, tagSig: clipSig }
    }

    if (kind === 'hex' && decoded.decode) {
        const dec = decoded.decode
        const p = dec.protocol || '?'
        const crc = dec.crcOk != null ? ` crc=${dec.crcOk}` : ''
        const env = parseEnvelopeNotes(dec.notes)
        const ba = dec.binaryAnalysis && typeof dec.binaryAnalysis === 'object' ? dec.binaryAnalysis : null
        const baEnv = ba && ba.envelope ? ba.envelope : null

        if (p === 'UartBinary') {
            const k = baEnv ? baEnv.kind : env && env.kind
            const b5 = baEnv ? baEnv.byte5 : env && env.b5
            const b6 = baEnv ? baEnv.byte6 : env && env.b6
            const blen =
                ba && ba.body_len != null
                    ? ba.body_len
                    : env && env.len != null
                      ? env.len
                      : dec.aabbBody
                        ? Math.floor(String(dec.aabbBody).length / 2)
                        : 0
            const bodyHex = (dec.aabbBody || (ba && ba.body_hex) || '').toLowerCase()
            const binSig = `bin:${bodyHex || hex}`
            const parts = [`protocol=UartBinary${crc}`]
            if (k != null) parts.push(`kind=0x${Number(k).toString(16).padStart(2, '0')}`)
            if (b5 != null) parts.push(`b5=0x${Number(b5).toString(16).padStart(2, '0')}`)
            if (b6 != null) parts.push(`b6=0x${Number(b6).toString(16).padStart(2, '0')}`)
            parts.push(`body_len=${blen}`)
            lines.push(parts.join(' '))
            lines.push(`hex: ${hex}`)
            if (sigFirstIndex && sigFirstIndex.has(binSig)) {
                lines.push(`body: (same as #${sigFirstIndex.get(binSig)})`)
            } else {
                if (bodyHex) {
                    lines.push(`body: ${bodyHex}`)
                    // Structured high-confidence fields from server analysis
                    const hits = (ba && ba.heuristics) || []
                    const high = hits.filter((h) => h.confidence === 'high' && h.width > 0)
                    if (high.length) {
                        lines.push(
                            'fields: ' +
                                high
                                    .map((h) => `+${h.offset}=${h.raw} (${h.interpretation})`)
                                    .join(' · '),
                        )
                    }
                } else lines.push('body: (empty)')
                if (sigFirstIndex) sigFirstIndex.set(binSig, index)
            }
            lines.push('')
            return { lines, tagSig: binSig }
        }

        // AABB fixed-layout (dryer/washer/fridge) — never use empty-TLV same-as
        if (p === 'Aabb' || p === 'AABB') {
            const bodyHex = (dec.aabbBody || (ba && ba.body_hex) || '').toLowerCase()
            const aabbSig = `aabb:${bodyHex || hex}`
            const parts = [`protocol=Aabb${crc}`]
            if (ba && ba.kind != null) {
                parts.push(`kind=0x${Number(ba.kind).toString(16).padStart(2, '0')}`)
            }
            if (ba && ba.frame_type != null) {
                parts.push(`type=0x${Number(ba.frame_type).toString(16).padStart(2, '0')}`)
            }
            if (ba && ba.kind_label) parts.push(`(${ba.kind_label})`)
            if (ba && ba.body_len != null) parts.push(`body_len=${ba.body_len}`)
            lines.push(parts.join(' '))
            lines.push(`hex: ${hex}`)
            if (sigFirstIndex && sigFirstIndex.has(aabbSig)) {
                lines.push(`body: (same as #${sigFirstIndex.get(aabbSig)})`)
            } else {
                if (bodyHex) lines.push(`body: ${bodyHex}`)
                else lines.push('body: (empty)')
                const fields = (ba && ba.fields) || []
                if (fields.length) {
                    lines.push(
                        'fields: ' +
                            fields
                                .map((f) => {
                                    // Command labels: interpretation only (no bogus u32 raw)
                                    if (
                                        f.name === 'monitor_enable' ||
                                        f.name === 'command'
                                    ) {
                                        return `${f.name}: ${f.interpretation || ''}`
                                    }
                                    // Status: name=value with short interpretation when useful
                                    const interp = f.interpretation || ''
                                    if (
                                        f.name === 'phase' &&
                                        interp &&
                                        !String(interp).startsWith(String(f.raw))
                                    ) {
                                        return `${f.name}=${f.raw} (${interp})`
                                    }
                                    if (f.name === 'remaining_min') {
                                        return `${f.name}=${f.raw}${
                                            interp && interp.includes('residual')
                                                ? ' (residual while Off)'
                                                : ' min'
                                        }`
                                    }
                                    return `${f.name}=${f.raw}`
                                })
                                .join(' · '),
                    )
                } else if (ba && ba.frame_type_label) {
                    lines.push(`frame: ${ba.frame_type_label}`)
                }
                if (sigFirstIndex) sigFirstIndex.set(aabbSig, index)
            }
            lines.push('')
            return { lines, tagSig: aabbSig }
        }

        // TLV / other
        const meta = [`protocol=${p}${crc}`]
        if (env) {
            meta.push(`kind=0x${env.kind.toString(16).padStart(2, '0')}`)
            if (env.b5 != null) meta.push(`b5=0x${env.b5.toString(16).padStart(2, '0')}`)
            if (env.b6 != null) meta.push(`b6=0x${env.b6.toString(16).padStart(2, '0')}`)
            if (env.b7 != null) meta.push(`b7=0x${env.b7.toString(16).padStart(2, '0')}`)
            if (env.len != null) meta.push(`len=${env.len}`)
        } else {
            const noteBits = (dec.notes || []).filter(
                (n) => !String(n).startsWith('packet_codec:') && !String(n).startsWith('binary body'),
            )
            if (noteBits.length) meta.push(noteBits.join(' · '))
        }
        lines.push(meta.join(' '))
        lines.push(`hex: ${hex}`)

        const els = dec.elements || []
        const sig = tagSignature(els)
        if (sigFirstIndex && sigFirstIndex.has(sig)) {
            lines.push(`tags: (same as #${sigFirstIndex.get(sig)})`)
        } else if (!els.length) {
            if (dec.aabbBody) lines.push(`body: ${dec.aabbBody}`)
            else lines.push('tags: (none)')
            if (sigFirstIndex) sigFirstIndex.set(sig, index)
        } else {
            lines.push(...formatTagsCompact(els))
            if (sigFirstIndex) sigFirstIndex.set(sig, index)
        }
        lines.push('')
        return { lines, tagSig: sig }
    }

    lines.push('(undecoded)')
    lines.push(`hex: ${hex}`)
    lines.push('')
    return { lines, tagSig: null }
}

/** Human-friendly value for sparse sensor timeline. */
function formatTagValueHint(e) {
    const t = Number(e.t)
    const v = Number(e.v)
    const base = formatOneTag(e)
    if (t === 0x1fd || t === 0x1fe) return `${base} → ${(v / 2).toFixed(1)}°C`
    // RAC/CST often RH×10 (≥200); DHUM uses percent (30–100).
    if (t === 0x336) {
        if (v >= 200) return `${base} → ${(v / 10).toFixed(1)}% RH`
        return `${base} → ${v}% RH`
    }
    return base
}

/**
 * Diff successive UartBinary bodies of same length — compact offset changes.
 * Highlights DHUM 0xa8 ambient/RH when present.
 */
function formatBinaryBodyDiffs(decodedList, ordered, t0) {
    const rows = []
    let prev = null
    decodedList.forEach((d, i) => {
        if (d.kind !== 'hex' || !d.decode || d.decode.protocol !== 'UartBinary') return
        const bodyHex = (
            d.decode.aabbBody ||
            (d.decode.binaryAnalysis && d.decode.binaryAnalysis.body_hex) ||
            ''
        ).toLowerCase()
        if (!bodyHex || bodyHex.length % 2) return
        const body = []
        for (let c = 0; c < bodyHex.length; c += 2) body.push(parseInt(bodyHex.slice(c, c + 2), 16))
        const ts = parseTsMs(ordered[i])
        const rel = t0 != null && ts != null ? `+${ts - t0}ms` : '?'
        if (!prev || prev.body.length !== body.length) {
            prev = { index: i + 1, body }
            return
        }
        const ch = []
        for (let o = 0; o < body.length; o++) {
            if (body[o] !== prev.body[o]) {
                let note = `+${o}: ${prev.body[o]}→${body[o]}`
                if (o === 44)
                    note += ` (${(prev.body[o] / 2).toFixed(1)}→${(body[o] / 2).toFixed(1)}°C)`
                if (o === 45) note += ` (${prev.body[o]}→${body[o]}% RH)`
                if (o === 4) note += ' seq'
                ch.push(note)
            }
        }
        if (ch.length) {
            rows.push(`#${prev.index}→#${i + 1} ${rel} ${ch.join(' · ')}`)
        }
        prev = { index: i + 1, body }
    })
    if (!rows.length) return []
    // Cap very long streams
    const max = 40
    const shown = rows.length > max ? rows.slice(0, max).concat([`… (${rows.length - max} more diffs)`]) : rows
    return ['## Binary body diffs', ...shown, '']
}

/**
 * Short RX values frames (1–3 tags) over long span — list as a timeline.
 * @param {object[]} decodedList
 * @param {HTMLElement[]} ordered
 * @param {number|null} t0
 */
function formatSparseValuesTimeline(decodedList, ordered, t0) {
    const rows = []
    decodedList.forEach((d, i) => {
        if (d.kind !== 'hex' || !d.decode) return
        if (d.decode.protocol !== 'Tlv' && d.decode.protocol !== 'TlvRaw') return
        const dir = ordered[i].dataset.dir || 'rx'
        if (dir !== 'rx') return
        const els = d.decode.elements || []
        if (els.length === 0 || els.length > 3) return
        // Full values dumps are long; sparse updates are short
        const env = parseEnvelopeNotes(d.decode.notes)
        if (env && env.b6 != null && env.b6 !== 0x04) return
        const ts = parseTsMs(ordered[i])
        const rel = t0 != null && ts != null ? `+${ts - t0}ms` : '?'
        const tags = els.map(formatTagValueHint).join(' ')
        rows.push(`#${i + 1} ${rel} ${tags}`)
    })
    if (rows.length < 2) return []
    return ['## Sparse RX updates', ...rows, '']
}

/** UART kind from a silent decode result, or null. */
function frameUartKind(decoded) {
    if (!decoded || decoded.kind !== 'hex' || !decoded.decode) return null
    const env = parseEnvelopeNotes(decoded.decode.notes)
    if (env) return env.kind
    const ba = decoded.decode.binaryAnalysis
    if (ba && ba.envelope && ba.envelope.kind != null) return Number(ba.envelope.kind)
    return null
}

/** True for host query stubs (e.g. only 0x1f5) — not useful for state deltas. */
function isQueryOnlyFrame(decoded) {
    if (!decoded || decoded.kind !== 'hex' || !decoded.decode) return true
    const els = decoded.decode.elements || []
    if (!els.length) return true
    if (els.every((e) => Number(e.t) === 0x1f5)) return true
    const kind = frameUartKind(decoded)
    // toDevice climate query/command with only a couple tags is usually poll noise
    if (kind === 0x65 && els.length <= 2) return true
    return false
}

/**
 * True when two TLV frames are worth a delta (same dialect / overlapping tags).
 * Avoids caps↔values noise and query_type-only TX noise.
 */
function framesComparableForDelta(a, b) {
    if (!a || !b || a.kind !== 'hex' || b.kind !== 'hex') return false
    const da = a.decode
    const db = b.decode
    if (!da || !db) return false
    if (da.protocol === 'UartBinary' || db.protocol === 'UartBinary') return false
    if (da.protocol !== 'Tlv' && da.protocol !== 'TlvRaw') return false
    if (db.protocol !== 'Tlv' && db.protocol !== 'TlvRaw') return false
    if (isQueryOnlyFrame(a) || isQueryOnlyFrame(b)) return false
    const elsA = da.elements || []
    const elsB = db.elements || []
    // Empty ACK vs full values — not comparable
    if (!elsA.length || !elsB.length) return false
    const kindA = frameUartKind(a)
    const kindB = frameUartKind(b)
    if (kindA != null && kindB != null && kindA !== kindB) return false
    const setA = new Set(elsA.map((e) => e.t))
    const setB = new Set(elsB.map((e) => e.t))
    let inter = 0
    for (const t of setA) if (setB.has(t)) inter++
    const union = setA.size + setB.size - inter
    if (union === 0) return false
    // Require meaningful overlap (same message family), not caps vs values
    return inter / union >= 0.25 || inter >= 8
}

function tlvDeltaSummary(mapA, mapB) {
    const appeared = []
    const disappeared = []
    const changed = []
    const allTags = new Set([...mapA.keys(), ...mapB.keys()])
    for (const t of [...allTags].sort((x, y) => x - y)) {
        const ea = mapA.get(t)
        const eb = mapB.get(t)
        const name = (eb && eb.name) || (ea && ea.name) || null
        const label = `0x${t.toString(16)}${name ? '(' + name + ')' : ''}`
        if (!ea && eb) appeared.push(`${label}=${eb.v}${eb.known ? '' : '*'}`)
        else if (ea && !eb) disappeared.push(`${label} was ${ea.v}${ea.known ? '' : '*'}`)
        else if (ea && eb && ea.v !== eb.v)
            changed.push(`${label}: ${ea.v}→${eb.v}${ea.known && eb.known ? '' : '*'}`)
    }
    return { appeared, disappeared, changed }
}

/**
 * Multi-select breakdown: all frames in time order (rx+tx), compact; optional first↔last TLV delta.
 * @param {HTMLElement[]} ordered
 */
async function runMultiFrameBreakdown(ordered) {
    if (!ordered || ordered.length < 2) return
    const dev = deviceContextLines()
    const t0 = parseTsMs(ordered[0])
    const tLast = parseTsMs(ordered[ordered.length - 1])
    const span = t0 != null && tLast != null ? tLast - t0 : null

    const last = ordered[ordered.length - 1]
    get('decode_hex').value = last.dataset.payload || ''
    get('decode_direction').value = last.dataset.dir === 'tx' ? 'toDevice' : 'fromDevice'
    get('decode_source').textContent = `${ordered.length} frames · ${
        span != null ? span + 'ms' : '?'
    }`

    try {
        const decodedList = await Promise.all(
            ordered.map((el) =>
                decodePayloadSilent(el.dataset.payload || '', el.dataset.dir || 'rx'),
            ),
        )

        // UI focus: last frame
        const lastDec = decodedList[decodedList.length - 1]
        const lastPayload = last.dataset.payload || ''
        if (lastDec.kind === 'clip') {
            renderClipBreakdown(lastPayload)
        } else if (lastDec.decode) {
            renderDecode(lastDec.decode)
            lastDecode = lastDec.decode
            renderPayloadView(lastDec.decode.hex || lastPayload, null)
        }

        const lines = []
        lines.push('# ThinQ frame sequence')
        lines.push(
            `device: ${dev.modelId} type=${dev.deviceTypeLabel || formatDeviceType(dev.deviceType)} id=${dev.id} platform=${dev.platform} mapped=${dev.mapped} bridged=${dev.bridged}`,
        )
        lines.push(
            `frames: ${ordered.length} · t0=${
                t0 != null ? new Date(t0).toISOString() : '?'
            } · span_ms=${span != null ? span : '?'}`,
        )
        lines.push('')
        lines.push('## Sequence (time order)')

        const sigFirstIndex = new Map()
        ordered.forEach((el, i) => {
            const d = decodedList[i]
            const payload = el.dataset.payload || ''
            const dir = el.dataset.dir || 'rx'
            const ts = parseTsMs(el)
            const { lines: block } = formatFrameCompact(
                i + 1,
                d,
                payload,
                dir,
                ts,
                t0,
                sigFirstIndex,
            )
            lines.push(...block)
        })

        lines.push(...formatSparseValuesTimeline(decodedList, ordered, t0))
        lines.push(...formatBinaryBodyDiffs(decodedList, ordered, t0))

        // TLV delta: prefer RX values dumps with real tag changes (not query_type polls).
        let best = null
        for (let i = 0; i < decodedList.length; i++) {
            for (let j = i + 1; j < decodedList.length; j++) {
                if (!framesComparableForDelta(decodedList[i], decodedList[j])) continue
                const mapA = tagMapFromDecode(decodedList[i].decode)
                const mapB = tagMapFromDecode(decodedList[j].decode)
                const summary = tlvDeltaSummary(mapA, mapB)
                const nTags = Math.min(mapA.size, mapB.size)
                const score =
                    summary.appeared.length + summary.disappeared.length + summary.changed.length
                if (score === 0) continue
                const envA = parseEnvelopeNotes(decodedList[i].decode.notes)
                const envB = parseEnvelopeNotes(decodedList[j].decode.notes)
                const dirA = ordered[i].dataset.dir || decodedList[i].dir || 'rx'
                const dirB = ordered[j].dataset.dir || decodedList[j].dir || 'rx'
                // Weight: change count, then tag richness, then RX values (b6=0x04)
                let rank = score * 100 + nTags
                if (dirA === 'rx' && dirB === 'rx') rank += 30
                if (envA && envA.b6 === 0x04 && envB && envB.b6 === 0x04) rank += 50
                if (!best || rank > best.rank || (rank === best.rank && j > best.j)) {
                    best = { i, j, mapA, mapB, summary, score, rank }
                }
            }
        }

        if (best) {
            const { appeared, disappeared, changed } = best.summary
            const idxA = best.i + 1
            const idxB = best.j + 1
            lines.push(`## TLV delta #${idxA}→#${idxB}`)
            lines.push(`* = unknown tag`)
            if (appeared.length) lines.push(`+ ${appeared.join(' · ')}`)
            if (disappeared.length) lines.push(`- ${disappeared.join(' · ')}`)
            if (changed.length) lines.push(`~ ${changed.join(' · ')}`)

            const body = get('tlv_body')
            const deltaB = decodedList[best.j]
            if (body && deltaB.decode.elements) {
                body.innerHTML = ''
                for (const el of deltaB.decode.elements) {
                    const tr = document.createElement('tr')
                    const prev = best.mapA.get(el.t)
                    let delta = ''
                    if (!prev) delta = ' <span style="color:var(--ok)">(+)</span>'
                    else if (prev.v !== el.v)
                        delta = ` <span style="color:var(--warn)">(${prev.v}→${el.v})</span>`
                    const status = el.known ? 'known' : 'unknown'
                    const hasSpan = el.byteEnd != null && el.byteEnd > (el.byteStart || 0)
                    tr.className = hasSpan ? 'has-span' : ''
                    if (hasSpan) {
                        tr.dataset.byteStart = String(el.byteStart)
                        tr.dataset.byteEnd = String(el.byteEnd)
                    }
                    tr.innerHTML = `
                        <td class="${status}"><code>${escapeHtml(
                            el.hex || '0x' + Number(el.t).toString(16),
                        )}</code></td>
                        <td>${escapeHtml(el.name || '—')}${delta}</td>
                        <td><code>${escapeHtml(String(el.v))}</code></td>
                        <td class="${status}">${el.known ? 'known' : 'UNKNOWN'}</td>`
                    if (hasSpan) attachTagHover(tr)
                    body.appendChild(tr)
                }
            }
            get('decode_summary').innerHTML = `sequence ${ordered.length} · span <b>${
                span != null ? span + 'ms' : '?'
            }</b> · delta #${idxA}→#${idxB} +${appeared.length} −${disappeared.length} ~${changed.length}`
        } else {
            get('decode_summary').innerHTML = `sequence ${ordered.length} · span <b>${
                span != null ? span + 'ms' : '?'
            }</b>`
        }

        get('text_breakdown').value = lines.join('\n').replace(/\n{3,}/g, '\n\n')
    } catch (err) {
        M.toast({ html: `sequence error: ${err}` })
    }
}

// Inject
get('btn_send_to').onclick = () => {
    if (!deviceWs || deviceWs.readyState !== WebSocket.OPEN) return
    let cmd = get('send_to').value.trim()
    if (!cmd) return
    if (cmd[0] === '{') {
        try {
            cmd = JSON.parse(cmd)
        } catch {
            M.toast({ html: 'invalid JSON' })
            return
        }
    }
    deviceWs.send(JSON.stringify({ sendToDevice: cmd }))
}
get('btn_send_from').onclick = () => {
    if (!deviceWs || deviceWs.readyState !== WebSocket.OPEN) return
    const hex = get('send_from').value.trim()
    if (!hex) return
    deviceWs.send(JSON.stringify({ sendFromDevice: hex }))
}

// ── Decode + text breakdown ───────────────────────────────────────────────

function attachTagHover(tr) {
    tr.addEventListener('mouseenter', () => {
        const b0 = tr.dataset.byteStart
        const b1 = tr.dataset.byteEnd
        if (b0 === '' || b1 === '' || b0 == null) return
        highlightPayloadBytes(Number(b0), Number(b1))
    })
    tr.addEventListener('mouseleave', () => {
        clearPayloadHighlight()
    })
}

function renderDecode(data) {
    lastDecode = data
    const body = get('tlv_body')
    body.innerHTML = ''
    const els = data.elements || []
    if (data.protocol === 'Aabb' || data.protocol === 'AABB') {
        const ba = data.binaryAnalysis || {}
        const fields = ba.fields || []
        if (fields.length) {
            body.innerHTML = ''
            for (const f of fields) {
                const tr = document.createElement('tr')
                tr.innerHTML = `
                    <td><code>+${f.offset}</code></td>
                    <td>${escapeHtml(f.name || '—')}</td>
                    <td><code>${escapeHtml(String(f.raw))}</code></td>
                    <td class="${f.confidence === 'high' ? 'known' : 'unknown'}">${escapeHtml(
                        f.interpretation || f.confidence || '',
                    )}</td>`
                body.appendChild(tr)
            }
        } else {
            body.innerHTML = `<tr><td colspan="4" class="empty-state">
                <b>AABB</b> — fixed layout (not TLV).
                kind=${ba.kind != null ? '0x' + Number(ba.kind).toString(16) : '?'}
                type=${ba.frame_type != null ? '0x' + Number(ba.frame_type).toString(16) : '?'}
                · ${escapeHtml(ba.kind_label || '')} ${escapeHtml(ba.frame_type_label || '')}
                · body=${ba.body_len || '?'}B — see text breakdown.
            </td></tr>`
        }
        get('decode_summary').innerHTML = `protocol=<b>Aabb</b> · ${escapeHtml(
            ba.kind_label || '',
        )} ${escapeHtml(ba.frame_type_label || '')} · fields=${fields.length}`
        renderPayloadView(data.hex || get('decode_hex').value, null)
        return
    }
    if (data.protocol === 'UartBinary') {
        const ba = data.binaryAnalysis || {}
        const env = ba.envelope || {}
        const hits = ba.heuristics || []
        body.innerHTML = `<tr><td colspan="4" class="empty-state">
            <b>UartBinary</b> — not climate TLV.
            kind=0x${Number(env.kind || 0).toString(16)} b5=0x${Number(env.byte5 || 0).toString(16)}
            b6=0x${Number(env.byte6 || 0).toString(16)} body=${ba.body_len || '?'}B ·
            ${hits.length} heuristic candidate(s) — see text breakdown.
        </td></tr>`
        get('decode_summary').innerHTML = `protocol=<b>UartBinary</b> · attempting structured RE (envelope + heuristics)`
        renderPayloadView(data.hex || get('decode_hex').value, null)
        return
    }
    if (els.length === 0) {
        body.innerHTML = `<tr><td colspan="4" class="empty-state">No TLV elements (protocol=${escapeHtml(
            data.protocol || '?',
        )}${data.aabbBody ? '; AABB body present — see text breakdown' : ''})</td></tr>`
    } else {
        for (const el of els) {
            const tr = document.createElement('tr')
            const status = el.known ? 'known' : 'unknown'
            const hasSpan = el.byteEnd != null && el.byteEnd > (el.byteStart || 0)
            tr.className = hasSpan ? 'has-span' : ''
            if (hasSpan) {
                tr.dataset.byteStart = String(el.byteStart)
                tr.dataset.byteEnd = String(el.byteEnd)
            }
            tr.innerHTML = `
                <td class="${status}"><code>${escapeHtml(el.hex || '0x' + Number(el.t).toString(16))}</code></td>
                <td>${escapeHtml(el.name || '—')}</td>
                <td><code>${escapeHtml(String(el.v))}</code></td>
                <td class="${status}">${el.known ? 'known' : 'UNKNOWN'}</td>`
            if (hasSpan) attachTagHover(tr)
            body.appendChild(tr)
        }
    }
    const sum = get('decode_summary')
    const unk = data.unknownCount ?? 0
    sum.innerHTML = `protocol=<b>${escapeHtml(data.protocol || '?')}</b> · dir=${escapeHtml(
        data.direction || '?',
    )} · unknowns=<b style="color:${unk ? 'var(--unknown)' : 'var(--ok)'}">${unk}</b>${
        data.crcOk == null ? '' : ' · crcOk=' + data.crcOk
    }${(data.notes || []).length ? ' · ' + escapeHtml(data.notes.join('; ')) : ''}`

    renderPayloadView(data.hex || get('decode_hex').value, null)
}

/** Decode TLV/AABB and always refresh the text breakdown. */
async function runDecode() {
    const hex = get('decode_hex').value.trim()
    if (!hex) {
        M.toast({ html: 'Nothing to decode' })
        return
    }
    if (isClipJsonPayload(hex)) {
        renderClipBreakdown(hex)
        return
    }
    const direction = get('decode_direction').value
    const model_id = get('decode_model').value || undefined
    try {
        const res = await fetch(`${baseUrl}api/re/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hex, direction, model_id }),
        })
        const data = await res.json()
        if (!data.ok) {
            M.toast({ html: data.error || 'decode failed' })
            return
        }
        if (data.decode) renderDecode(data.decode)
        get('text_breakdown').value = data.text || ''
    } catch (err) {
        M.toast({ html: `decode error: ${err}` })
    }
}

// Keep payload view in sync when user pastes hex manually
get('decode_hex')?.addEventListener('input', () => {
    renderPayloadView(get('decode_hex').value, null)
})

async function copyExport() {
    const text = get('text_breakdown').value
    if (!text) {
        M.toast({ html: 'Nothing to copy yet' })
        return
    }
    try {
        await navigator.clipboard.writeText(text)
        M.toast({ html: 'Copied text breakdown' })
    } catch {
        get('text_breakdown').select()
        document.execCommand('copy')
        M.toast({ html: 'Copied (fallback)' })
    }
}

get('btn_decode')?.addEventListener('click', runDecode)
get('btn_copy_export')?.addEventListener('click', copyExport)

// ── Status WebSocket ──────────────────────────────────────────────────────

let retryDelay = 250

function connect() {
    clearTimeout(reconnectTimer)
    if (ws) {
        ws.onclose = ws.onopen = ws.onmessage = null
        try {
            ws.close()
        } catch (_) {}
    }
    ws = new WebSocket(baseUrl + 'ws')

    ws.onclose = () => {
        get('status_rethink').innerHTML = STATUS_ERROR
        get('status_mqtt').innerHTML = STATUS_UNKNOWN
        document.body.classList.add('offline')
        reconnectTimer = setTimeout(connect, retryDelay)
        retryDelay = 5000
    }

    ws.onopen = () => {
        retryDelay = 250
        get('status_rethink').innerHTML = STATUS_OK
        document.body.classList.remove('offline')
    }

    ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return
        const json = JSON.parse(ev.data)
        if (typeof json.ha === 'boolean') {
            get('status_mqtt').innerHTML = json.ha ? STATUS_OK : STATUS_ERROR
        }

        if (typeof json.devices === 'object') {
            Object.keys(devices)
                .filter((id) => !json.devices[id])
                .forEach((id) => {
                    devices[id].destroy()
                    delete devices[id]
                    if (selectedDeviceId === id) {
                        selectedDeviceId = null
                        get('workbench').classList.remove('active')
                        if (deviceWs) {
                            try {
                                deviceWs.close()
                            } catch (_) {}
                        }
                    }
                })
            for (const id in json.devices) {
                const j = json.devices[id]
                if (!devices[id]) devices[id] = new DeviceEntry(id, j, get('devices_body'))
                else devices[id].update(j)
            }
            updateDevicesEmpty()
            // Deep-link or re-select after list refresh
            if (selectedDeviceId && devices[selectedDeviceId] && !get('workbench').classList.contains('active')) {
                selectDevice(selectedDeviceId)
            }
        }

        if (typeof json.bridge === 'object') {
            bridge_status = json.bridge.loggedIn
            if (json.bridge.disabled) {
                get('btn_thinq_login').classList.add('hide')
                get('btn_thinq_logout').classList.add('hide')
                get('status_bridge').innerHTML = STATUS_DISABLED
                get('status_bridge_text').innerText = 'Disabled by configuration'
            } else if (json.bridge.loggedIn === true) {
                get('btn_thinq_login').classList.add('hide')
                get('btn_thinq_logout').classList.remove('hide')
                get('status_bridge').innerHTML = STATUS_OK
                get('status_bridge_text').innerText = 'Ok'
            } else {
                get('btn_thinq_login').classList.remove('hide')
                get('btn_thinq_logout').classList.add('hide')
                get('status_bridge').innerHTML = STATUS_ERROR
                get('status_bridge_text').innerText = 'Not logged in'
            }
            for (const id in devices) devices[id].refreshUI()
        }

        if (typeof json.status === 'string') {
            M.toast({ html: json.status })
        }
    }
}

get('btn_thinq_login_continue').onclick = () => {
    if (!get('country_code').validity.valid) return
    const countryCode = get('country_code').value.toUpperCase()
    window.open(`${baseUrl}thinq_login?countryCode=${countryCode}`, '_blank')
}

get('btn_thinq_login_complete').onclick = async () => {
    if (!get('country_code').validity.valid) return
    if (!get('login_url').validity.valid) return
    const countryCode = get('country_code').value.toUpperCase()
    const url = get('login_url').value
    await fetchWrapper(`thinq_login_accept`, { url, countryCode }, { method: 'POST' })
    M.Modal.getInstance(get('thinq_login')).close()
}

get('btn_thinq_logout_continue').onclick = async () => {
    await fetchWrapper(`thinq_logout`, {}, { method: 'POST' })
    M.Modal.getInstance(get('thinq_logout')).close()
}

window.addEventListener('pageshow', (ev) => {
    if (ev.persisted) connect()
})

async function fetchWrapper(path, body, options) {
    if (options.method !== 'GET') {
        if (!options.headers) options.headers = {}
        options.headers['Content-type'] = 'application/json'
    }
    options.body = JSON.stringify(body)
    try {
        const response = await fetch(`${baseUrl}${path}`, options)
        if (response.status >= 300) M.toast({ html: `HTTP error ${response.status}: ${await response.text()}` })
        return response
    } catch (err) {
        M.toast({ html: `FETCH error: ${err}` })
    }
}

// Deep-link: ?id=DEVICE still works (select on connect when device appears)
const bootId = new URLSearchParams(window.location.search).get('id')
if (bootId) {
    // Will select once device list arrives; also open workbench early
    selectedDeviceId = bootId
}

updateDevicesEmpty()
connect()

// After devices appear, apply boot selection
const _origOnMsg = null
// Poll once shortly after load for deep-link
setTimeout(() => {
    if (bootId && devices[bootId]) selectDevice(bootId)
}, 800)
