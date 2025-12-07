import { spawn } from 'node:child_process'
import { type Express } from "express-serve-static-core"
import { CA, ClipDeployMessage, Config } from '../util/types.js'

export function setupHttp(app: Express, config: Config, ca: CA) {
	app.get('/route', (req, res) => {
		res.json({
			"resultCode": "0000",
			"result": {
				"apiServer": "https://" + config.hostname + ":" + config.https_port, 
				"mqttServer": "ssl://" + config.hostname + ":" + config.mqtts_port 
			}
		})
	})

	app.get('/route/certificate', (req, res) => {
		if(req.query.name) {
			res.json({"resultCode":"0000", "result":{"certificatePem": ca.cert}})
		} else {
			res.json({"resultCode": "0000", "result": ["common-server", "aws-iot"]})
		}
	})

	app.post('/device/:deviceId/certificate', (req, res) => {
		const x509 = spawn('openssl', ['x509', '-req', '-in', '-', 
			'-days', '3650', '-CA', config.ca_cert_file, '-CAkey', config.ca_key_file, '-set_serial', '0100', '-out', '-'])
		const out = []
		x509.stdout.on('data', (data) => {
			out.push(data)
		})
		x509.stderr.on('data', () => {})
		x509.on('close', (code) => {
			// Warning: we don't supply MQTT topics at this point. Maybe we should?
			// OTOH, the firmware seems to ignore it outright...
			res.json({"resultCode": "0000", "result": {"certificatePem": Buffer.concat(out).toString('utf-8').replace(/\r/g,"")}})
		})
		x509.stdin.end(req.body.csr)
	});
}

export function generateDeployResponse(payload: ClipDeployMessage) {
	return {
		"did": payload.did,
		"mid": Date.now(),
		"cmd": "completeProvisioning",
		"type":0,
		"data": {
			"result":0,
			"host": "message",
			"appInfo": {
				"host":"message",
				"publication":{
					// this path is arbitrary
					"message": "clip/message/devices/" + payload.did,

					// This path is not-so-arbitrary, because the device will cache it
					// and try to reuse it on a next provisioning attempt. We pick the
					// default path that is used by the firmware, so that we can be sure
					// that it will keep working if you revert to the official cloud.

					// The paths ARE sent by the API server during certificate generation
					// but the firmware I've worked with seems to ignore them.
					"provisioning": "clip/provisioning/devices/" + payload.did
				}
			},
			"provisioningType": payload.cmd,
			"deployInterval":600
		}
	}
}