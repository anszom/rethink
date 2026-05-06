// base implementation for devices with a TLV-based payload format
import HADevice from './base'

import crc16 from '@/util/crc16'
import * as TLV from '@/util/tlv'
import { Device as Thinq2Device } from '../thinq2/device'
import { ComponentDiscovery, DeviceDiscovery, type Config, type Connection } from '../homeassistant'
import log from '@/util/logging'

export type FieldDefinition = {
    id?: number
    name: string
    state_topic?: string
    readable?: boolean
    writable?: boolean
    write_xform?: (val: string) => string | number | null | undefined
    write_attach?: number[] | ((val: unknown) => number[])
    read_xform?: (val: number) => string | number | undefined // undefined return values are discarded
    read_callback?: (val: string | number) => boolean
    write_callback?: (val: number) => boolean
}

export type ComponentFieldDefinition = FieldDefinition & {
    comp: string
}

export default class TLVDevice extends HADevice {
    query_timer: ReturnType<typeof setInterval> | undefined
    fields_by_id: Record<number, FieldDefinition | ComponentFieldDefinition> = {}
    fields_by_ha: Record<string, FieldDefinition | ComponentFieldDefinition> = {}
    raw_clip_state: Record<number, number> = {}
    query_caps_timeout: ReturnType<typeof setInterval> | undefined = undefined

    constructor(
        HA: Connection,
        ha_class: string,
        readonly thinq: Thinq2Device,
    ) {
        super(HA, ha_class, thinq.id)
        thinq.on('data', (data) => this.processData(data))

        // initial capabilities query
        this.queryCaps()

        // retry every 15 s until caps are received
        this.query_caps_timeout = setInterval(() => {
            log('status', this.id, 're-trying capabilities query due to timeout')
            this.queryCaps()
        }, 15 * 1000)
    }

    // we waste memory by storing the field set per-device, not per-class. Whatever.
    addField(config: ComponentDiscovery, options: FieldDefinition, autoreg?: boolean): void
    addField(config: DeviceDiscovery, options: ComponentFieldDefinition, autoreg?: boolean): void
    addField(config: Config, options: FieldDefinition | ComponentFieldDefinition, autoreg?: boolean) {
        if (options.id) this.fields_by_id[options.id] = options

        let fullName: string = ''
        if ('comp' in options) {
            fullName = options.comp + '-' + options.name
        } else {
            fullName = options.name
        }
        if (fullName !== '') {
            this.fields_by_ha[fullName] = options
        }

        if (autoreg !== false) {
            let topicPrefix: string = ''
            if (options.name !== '') {
                topicPrefix = options.name + '_'
            }

            let target: any

            if ('comp' in options) {
                target = (config as DeviceDiscovery)['components'][options.comp]
            } else {
                target = config
            }

            if (options.readable !== false) {
                const stateTopic = options.state_topic == null ? 'state_topic' : options.state_topic
                target[topicPrefix + stateTopic] = '$this/' + fullName
            }

            if (options.writable !== false) target[topicPrefix + 'command_topic'] = '$this/' + fullName + '/set'
        }
    }

    // clip-side
    queryCaps() {
        this.send([1, 1, 2, 2, 1], [{ t: 0x1f5, v: 1 }])
    }

    query() {
        this.send([1, 1, 2, 2, 1], [{ t: 0x1f5, v: 2 }])
    }

    start() {
        this.query()

        // Refresh every 15 minutes since not every tag change generates async notify
        this.query_timer = setInterval(
            () => {
                log('status', this.id, 'sending periodic refresh query')
                this.query()
            },
            15 * 60 * 1000,
        )
    }

    drop() {
        if (this.query_timer != undefined) {
            clearInterval(this.query_timer)
            this.query_timer = undefined
        }

        if (this.query_caps_timeout != undefined) {
            clearInterval(this.query_caps_timeout)
            this.query_caps_timeout = undefined
        }

        super.drop()
    }

    processData(buf: Buffer) {
        if (
            buf[2] == 0x04 &&
            buf[3] == 0x00 &&
            buf[4] == 0x00 &&
            buf[5] == 0x00 &&
            buf[6] == 0x87 &&
            buf[7] == 0x02 &&
            (buf[8] == 0x01 || buf[8] == 0x04) &&
            /* && buf[9] is a "sequence" number */ buf[10] == buf.length - 13
        ) {
            // ignore the CRC, we assume that the modem verifies it :/
            log('status', this.id, 'received TLV packet')
            this.processTLV(TLV.parse(buf.subarray(11, buf.length - 2)))
        }
        if (
            buf[1] == 0xff &&
            buf[2] == 0x04 &&
            buf[3] == 0x00 &&
            buf[4] == 0x00 &&
            buf[5] == 0x00 &&
            buf[6] == 0x87 &&
            buf[7] == 0xfd &&
            buf[8] == 0x03 &&
            buf[10] == buf.length - 13
        ) {
            this.processPrivData(buf[0], buf[9], buf.subarray(11, buf.length - 2))
        }
        if (
            (buf[0] == 0x02 || buf[0] == 0x03) &&
            buf[2] == 0x04 &&
            buf[3] == 0x00 &&
            buf[4] == 0x00 &&
            buf[5] == 0x00 &&
            buf[6] == 0x87 &&
            buf[7] == 0xfd &&
            buf[8] == 0x10 &&
            buf[9] == 0x00 &&
            buf[10] == 0x05 &&
            buf[11] == 0xfe &&
            buf[12] != null
        ) {
            this.processPrivDataCmdResp(buf[0] == 0x02, buf[1], buf[12], buf.subarray(13, buf.length - 2))
        }
    }

    send(header: number[], tlv: TLV.TLV[]) {
        const [b0, b1, b2, b3, b4] = header
        const tlvArray = TLV.build(tlv)
        let buf = [0x04, 0x00, 0x00, 0x00, 0x65, b2, b3, b4, tlvArray.length].concat(tlvArray)
        const result = crc16(buf)
        buf = [b0, b1].concat(buf, [result >> 8, result & 0xff])
        this.thinq.send_packet(Buffer.from(buf))
    }

    isCapsResponse(tlvArray: TLV.TLV[]) {
        /* To be overridden */
        return false
    }

    sendPrivCommand(cmd: number, cmd_sub: number, data: Buffer = Buffer.alloc(0)) {
        const cmdDataLen = data.length + 1
        const header = Buffer.from([
            0x00,
            0xff,
            0x04,
            0x00,
            0x00,
            0x00,
            0x65,
            0xfd,
            cmd_sub,
            cmdDataLen >> 8,
            cmdDataLen & 0xff,
            cmd,
        ])
        let buf = Buffer.concat([header, data])

        const crc = crc16(buf.subarray(2))
        buf = Buffer.concat([buf, Buffer.from([crc >> 8, crc & 0xff])])

        this.thinq.send_packet(buf)
    }

    capabilityReceived() {
        /* To be overridden if necessary */
    }

    processPrivData(cmd: number, buf9: number, data: Buffer) {
        /* To be overridden */
    }

    processPrivDataCmdResp(success: boolean, buf1: number, cmd: number, data: Buffer) {
        /* To be overridden */
    }

    processTLV(tlvArray: TLV.TLV[]) {
        tlvArray.forEach(({ t, v }) => this.processKeyValue(t, v))

        if (this.query_caps_timeout != undefined && this.isCapsResponse(tlvArray)) {
            log('status', this.id, 'received capability key')
            clearInterval(this.query_caps_timeout)
            this.query_caps_timeout = undefined
            this.capabilityReceived()
        }
    }

    processKeyValue(k: number, v: number) {
        this.raw_clip_state[k] = v

        const def = this.fields_by_id[k]
        if (!def) return

        let processed: string | number = v

        if (def.read_xform) {
            let tmp = def.read_xform(processed)
            if (tmp === undefined) return
            processed = tmp
        }

        var doRead = true
        if (def.read_callback) doRead = def.read_callback(processed)
        if (doRead) {
            if (def.readable === false) return

            let fullName: string = ''
            if ('comp' in def) {
                fullName = def.comp + '-' + def.name
            } else {
                fullName = def.name
            }

            this.HA.publishProperty(this.id, fullName, processed)
        }
    }

    // HA-side
    setProperty(prop: string, mqttValue: string) {
        //console.log("HA write", prop, mqttValue)
        const def = this.fields_by_ha[prop]
        if (!def || def.writable === false) {
            console.warn(`Attempting to set property ${prop} which is not writable`)
            return
        }

        let value: string | number | null | undefined
        if (def.write_xform) value = def.write_xform(mqttValue)

        if (value === null || value === undefined) return

        if (typeof value === 'string') value = Number(value)

        var doWrite = true
        if (def.write_callback) doWrite = def.write_callback(value)
        if (doWrite && def.id !== undefined) {
            this.raw_clip_state[def.id] = value

            let attach: number[] = []
            if (Array.isArray(def.write_attach)) attach = def.write_attach
            if (typeof def.write_attach === 'function') attach = def.write_attach(value)

            const write_fields = [def.id].concat(attach)
            const tlvArray = write_fields.map((id) => ({ t: id, v: this.raw_clip_state[id] }))
            //console.log("Sending ", tlvArray)
            this.send([1, 1, 2, 1, 1], tlvArray)
        }
    }
}
