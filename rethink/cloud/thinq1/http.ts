import { Request, Response, Router } from 'express'
import { Config } from '../../util/config.js';
import { XMLParser, XMLBuilder, XMLValidator} from 'fast-xml-parser';
import { Metadata } from '../thinq.js';

const XML_HEADER = '<?xml version="1.0" encoding="utf-8" standalone="yes"?>'

const deviceMeta: Record<string, Metadata> = {}
export function getDeviceMetadata(id: string) {
    return deviceMeta[id]
}

function xmlParser(req: Request, res: Response, next: () => void) {
    const buffers: Buffer[] = []
    let length = 0
    let error = false

    req.on('data', (data) => {
        if(!error) {
            buffers.push(data)
            length += data.length
            if(length > 1000000) {
                res.status(400).end()
                error = true
            }
        }
    })

    req.on('end', () => {
        if(!error) {
            req.body = new XMLParser().parse(Buffer.concat(buffers))
            next()
        }
    })
}

export function routes(config: Config) {
    const router = Router();
    router.use(xmlParser)

    router.post('/lgehadm/api/Device/TotalDeviceInfoSvc', (req, res) => {
        const response: any = {
            returnCd: '0000',
            returnMsg: 'OK',
        }

        const deviceId = req.header('x-lgedm-deviceid')
        const modelName = req.body?.lgedmRoot?.modelName
        if(!deviceId)
            return res.status(400).end()

        if(modelName)
            deviceMeta[deviceId] = {
                modelId: modelName,
                modelName,
            }

        if(req.body?.lgedmRoot?.itemList?.item === 'DM_SETTING_INFO_GET_URI') {
            response.itemList = {
                elementList: {
                    elementCode: 'settingInfoList',
                    elementValueList: {
                        code: 'BlackBox',
                        value: 'N'
                    }
                },
                item: 'DM_SETTING_INFO_GET_URI',
                returnCode: '0000'
            }
        
        } else if(req.body?.lgedmRoot?.itemList?.item === 'THINQ_TIME_SYNC_URI') {
            response.itemList = {
                elementList: [
                    {
                        elementCode: 'utcTime',
                        elementValue: new Date().toISOString().replace(/T|\....Z/g, ' ').trim(),
                    },
                    {
                        elementCode: 'timezone',
                        elementValue: 0,
                    },
                ],
                item: 'THINQ_TIME_SYNC_URI',
                returnCode: '0000'
            }
        }

        res.header('Content-type: text/xml;charset=utf-8')
        res.end(XML_HEADER + new XMLBuilder().build({lgedmRoot: response }))
	})

    router.post('/lgehadm/api/Grid/PowerSavingInfoSvc', (req, res) => {
        res.header('Content-type: text/xml;charset=utf-8')
        res.end(XML_HEADER + new XMLBuilder().build({lgedmRoot: { returnCd: '0108', returnMsg: 'No Saving Data.' }}))
    })

    router.post('/lgehadm/api/Rtos/FWInfoSettingSvc', (req, res) => {
        res.header('Content-type: text/xml;charset=utf-8')
        res.end(XML_HEADER + new XMLBuilder().build({lgedmRoot: { returnCd: '0000', returnMsg: 'OK' }}))
    })

    router.post('/lgehadm/report/diagmon', (req, res) => {
        res.end();
    })
   
    return router;
}