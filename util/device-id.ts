const DEVICE_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/

export function validDeviceId(deviceId: unknown): deviceId is string {
    return typeof deviceId === 'string' && DEVICE_ID_RE.test(deviceId)
}
