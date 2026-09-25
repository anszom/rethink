import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
    DEVICE_CONFIG_HEADERS,
    deviceConfigBody,
    deviceInfoBody,
    parseMembers,
    request,
    statusCode,
    timezone,
} from '@/util/whisen'

// Captured from a WH09SKN-18 (RAC_056905_WW, 2.6.7_RTOS_3K) during a successful provisioning.
// Every write step answered exactly these 16 bytes.
const REPLY_200 = 'HTTP/1.1 200\r\n\r\n'
// GetDeviceInfo on that firmware.
const REPLY_500 = 'HTTP/1.1 500\r\n\r\n'

describe('whisen framing', () => {
    test('request line, headers, blank line, body, all CRLF', () => {
        const r = request('/SetDeviceInit', '')
        assert.equal(r, 'POST /SetDeviceInit HTTP/1.1\r\nContent-Length: 0\r\n\r\n')
    })

    test('SetDeviceInfo body is bare members with a trailing CRLF, as the app sends it', () => {
        const body = deviceInfoBody('DE', 'rethink')
        assert.equal(body, '"Nation":"DE",\r\n"regionalCode":"rethink"\r\n')
        assert.equal(
            request('/SetDeviceInfo', body),
            'POST /SetDeviceInfo HTTP/1.1\r\nContent-Length: 42\r\n\r\n' + body,
        )
    })

    test('SetDeviceConfig omits HomeApKeyType unless asked, and uses the app headers verbatim', () => {
        const body = deviceConfigBody('HomeWifi', 'secret', '+0100')
        assert.equal(body, '"HomeApSSID":"HomeWifi",\r\n"HomeApPW":"secret",\r\n"TimeZone":"+0100"')
        assert.equal(
            request('/SetDeviceConfig', body, DEVICE_CONFIG_HEADERS),
            'POST /SetDeviceConfig HTTP/1.1\r\nContent-Length: 0\r\nSession-Id: \r\n\r\n' + body,
        )
        assert.ok(deviceConfigBody('x', 'y', '+0000', 'WPA/WPA2').includes('"HomeApKeyType":"WPA/WPA2",\r\n'))
    })

    test('quotes and backslashes are escaped as in JSON, other characters are sent as they are', () => {
        assert.equal(
            deviceConfigBody('rt"q', 'pass\\word"12', '+0100'),
            '"HomeApSSID":"rt\\"q",\r\n"HomeApPW":"pass\\\\word\\"12",\r\n"TimeZone":"+0100"',
        )
        assert.ok(deviceConfigBody("a b,c:d'{é}", 'y', '+0100').startsWith('"HomeApSSID":"a b,c:d\'{é}",\r\n'))
    })

    test('timezone formats like the app', () => {
        assert.equal(timezone(120), '+0200')
        assert.equal(timezone(-330), '-0530')
        assert.equal(timezone(0), '+0000')
        assert.equal(timezone(60), '+0100')
    })

    test('status code from the captured replies', () => {
        assert.equal(statusCode(REPLY_200), 200)
        assert.equal(statusCode(REPLY_500), 500)
        assert.equal(statusCode(''), undefined)
        assert.equal(statusCode('"a":"b"'), undefined)
    })

    test('member parsing keeps only what follows the first quote', () => {
        assert.deepEqual(parseMembers('HTTP/1.1 200\r\n\r\n"Model":"RAC_056905_WW",\r\n"Ver":"1"\r\n'), {
            Model: 'RAC_056905_WW',
            Ver: '1',
        })
        assert.equal(parseMembers(REPLY_500), undefined)
    })
})
