/*
 * Framing for the Whisen SoftAP setup protocol: HTTP/1.1 POST over TLS on port 9000, one request per
 * connection, no authentication. Bodies are bare JSON members separated by CRLF. SetDeviceConfig
 * declares "Content-Length: 0" and an empty "Session-Id:" although it carries a body; the LG app
 * has always sent it that way, so it is reproduced verbatim.
 */

export const WHISEN_PORT = 9000

/** The appliance's own address on its SoftAP, which hands out 192.168.1.x to the client. */
export const WHISEN_HOST = '192.168.1.1'

export function request(path: string, body: string, headers = [`Content-Length: ${body.length}`]): string {
    return [`POST ${path} HTTP/1.1`, ...headers, '', body].join('\r\n')
}

/** Timezone as the app formats it: sign, two-digit hours, two-digit minutes, e.g. "+0100". */
export function timezone(offsetMinutesEastOfUTC: number): string {
    const sign = offsetMinutesEastOfUTC < 0 ? '-' : '+'
    const a = Math.abs(offsetMinutesEastOfUTC)
    return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}${String(a % 60).padStart(2, '0')}`
}

/** Body for /SetDeviceInfo. regionalCode is what the appliance dials afterwards as <code>.lgthinq.com. */
export function deviceInfoBody(nation: string, regionalCode: string): string {
    return `"Nation":"${nation}",\r\n"regionalCode":"${regionalCode}"\r\n`
}

/**
 * Body for /SetDeviceConfig. keyType is only sent by the app for a hand-typed (hidden) SSID; for a
 * network picked from the scan list it is left out.
 */
export function deviceConfigBody(
    ssid: string,
    password: string,
    tz: string,
    keyType?: 'WPA/WPA2' | 'WEP' | 'OPEN',
): string {
    const lines = [`"HomeApSSID":"${ssid}",`, `"HomeApPW":"${password}",`]
    if (keyType) lines.push(`"HomeApKeyType":"${keyType}",`)
    lines.push(`"TimeZone":"${tz}"`)
    return lines.join('\r\n')
}

/** Headers the app puts on /SetDeviceConfig, body notwithstanding. */
export const DEVICE_CONFIG_HEADERS = ['Content-Length: 0', 'Session-Id: ']

/** The status code from a reply, or undefined when there is no status line. */
export function statusCode(reply: string): number | undefined {
    const m = /^HTTP\/1\.[01] (\d{3})/.exec(reply)
    return m ? Number(m[1]) : undefined
}

/** What the app keeps of a reply: everything from the first double quote onward, wrapped in braces. */
export function parseMembers(reply: string): Record<string, unknown> | undefined {
    const i = reply.indexOf('"')
    if (i === -1) return undefined
    try {
        return JSON.parse('{' + reply.substring(i).replace(/\r?\n/g, '').replace(/,\s*$/, '') + '}')
    } catch {
        return undefined
    }
}
