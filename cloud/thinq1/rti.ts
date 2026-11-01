// Thinq1 device-side message bodies:
//
// DevInfo:
//  {"CmdWId":"7f6816e0-99a3-11f0-b166-7c1c4ec8cc53","Cmd":"DevInfo","Format":"B64","Data":"UnVsZVZlcj0xLjMsRndWZXI9UUNfTW9kZW1fMS4yLjgwLHJlZ0ZhaWw9Tg=="}}
// Response:
//  {"CmdWId":"7f6816e0-99a3-11f0-b166-7c1c4ec8cc53","ReturnCode":"0000"}
//
// Alive:
//  {"CmdWId":"8571a6f0-99a3-11f0-856f-7c1c4ec8cc53","Cmd":"Alive"}
// Response:
//  {"CmdWId":"8571a6f0-99a3-11f0-856f-7c1c4ec8cc53","ReturnCode":"0000"}
//
// Status (sent between Start & Stop):
//  {"CmdWId":"n-48552db0-1ab4-11e9-b4fb-7c1c4ec8cc53","ReturnCode":"0000","Format":"B64","Data":"AQAAAAAAAAAAAAAAAAAAAAAAAAAABgBkAAAAAA=="}
// No response.
//
// Server-side messages:
// Start:
//  {"CmdWId":"n-48552db0-1ab4-11e9-b4fb-7c1c4ec8cc53","Cmd":"Mon","CmdOpt":"Start"}
// Response:
//  {"CmdWId":"n-48552db0-1ab4-11e9-b4fb-7c1c4ec8cc53","ReturnCode":"0000"}
// Stop:
//  {"CmdWId":"n-48552db0-1ab4-11e9-b4fb-7c1c4ec8cc53","Cmd":"Mon","CmdOpt":"Stop"}
// Response:
//  {"CmdWId":"n-48552db0-1ab4-11e9-b4fb-7c1c4ec8cc53","ReturnCode":"0000"}

export const MON_START = { Cmd: 'Mon', CmdOpt: 'Start' }
export const MON_STOP = { Cmd: 'Mon', CmdOpt: 'Stop' }

export type MessageBody = {
    CmdWId?: string
    Cmd?: string
    CmdOpt?: string
    Format?: string
    Data?: string
    ReturnCode?: string
    Value?: unknown
}

export type Message = {
    Header?: {
        'x-lgedm-deviceId'?: string
    }
    Body?: MessageBody
}

export function isAck(body: MessageBody) {
    return 'CmdWId' in body && 'ReturnCode' in body && Object.keys(body).length === 2
}

export function isAlive(body: MessageBody) {
    return body.Cmd === 'Alive'
}

export function isMonStart(body: MessageBody) {
    return body.Cmd === 'Mon' && body.CmdOpt === 'Start'
}

export function isMonStop(body: MessageBody) {
    return body.Cmd === 'Mon' && body.CmdOpt === 'Stop'
}

export function isStatus(body: MessageBody) {
    return body.Cmd === undefined && body?.Format === 'B64' && typeof body.Data === 'string'
}

export function isDevInfo(body: MessageBody) {
    return body.Cmd === 'DevInfo'
}

export function statusMessage(deviceId: string, buf: Buffer): MessageBody {
    // device status message
    // CmdWId: n-$DevideID
    // ReturnCode: 0000
    return {
        CmdWId: `n-${deviceId}`,
        ReturnCode: '0000',
        Format: 'B64',
        Data: buf.toString('base64'),
    }
}

export function format(body: MessageBody) {
    if (isStatus(body)) return body.Data
    else return JSON.stringify(body)
}
