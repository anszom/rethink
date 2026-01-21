import { IPublishPacket, IConnectPacket, ISubscribePacket, IUnsubscribePacket } from 'mqtt-packet';
import newMqttConnection, { MqttConnection } from 'mqtt-connection'
import { TypedEmitter } from 'tiny-typed-emitter';
import { Socket } from 'node:net';

export type PublishPacket = Omit<IPublishPacket, 'cmd'>;

class Subscription {
	re: RegExp

	constructor(topicPattern) {
		const re = "^" + topicPattern.replace(/#$/, '.*').replace(/\+/g, '[^/]*') + "$";
		this.re = new RegExp(re)
	}

	match(topic) {
		return !!topic.match(this.re)
	}
}

type LWT = IConnectPacket['will']
type ClientEvents = {
	destroy: (will: LWT) => void;
};

export class Client extends TypedEmitter<ClientEvents> {
	subscriptions = new Map<string, Subscription>()
	mqtt: any = undefined
	will: LWT

	constructor(mqtt: MqttConnection, retainMap: Map<String, PublishPacket>) {
		super()

		this.mqtt = mqtt
		mqtt.on('connect', (packet) => {
			if(packet.will) {
				this.will = packet.will
			}
			mqtt.connack({returnCode: 0, sessionPresent: false})
		})

		mqtt.on('publish', (packet) => {
			if(packet.qos > 0)
				mqtt.puback({messageId: packet.messageId})
		})

		mqtt.on('pingreq', () => {
			mqtt.pingresp({})
		})

		mqtt.on('subscribe', (packet) => {
			// we grant all subscriptions with QoS = 0
			const granted = packet.subscriptions.map(() => 0)
			mqtt.suback({granted: granted, messageId: packet.messageId})

			// collect all retained topics that aren't yet covered by this client's subscriptions
			const unseenRetainedTopics = []
			for(const t of retainMap.keys()) {
				let seen = false
				for(const s of this.subscriptions.values()) {
					if(s.match(t)) {
						seen = true
						break;
					}
				}

				if(!seen)
					unseenRetainedTopics.push(t)
			}
			
			// register new subscriptions
			const newSubscriptions = []
			packet.subscriptions.forEach((el) => {
				const newSub = new Subscription(el.topic)
				newSubscriptions.push(newSub)
				this.subscriptions.set(el.topic, newSub)
			})

			// deliver retained messages that match any of the new subscriptions
			for(const t of unseenRetainedTopics) {
				for(const s of newSubscriptions) {
					if(s.match(t)) {
						mqtt.publish(retainMap.get(t))
						break
					}
				}
			}
		})

		mqtt.on('unsubscribe', (packet) => {
			mqtt.unsuback({ messageId: packet.messageId})
			packet.unsubscriptions.forEach((topic) => {
				this.subscriptions.delete(topic)
			})
		})

		mqtt.on('close', () => { 
			this.destroy()
		})
		mqtt.on('error', (err) => { 
			console.warn(err)
			this.destroy()
		})
		mqtt.on('disconnect', () => {  
			this.destroy()
		})
	}

	destroy() {
		if(!this.mqtt) 
			return

		this.mqtt.destroy() 
		this.mqtt = null
		this.emit('destroy', this.will)
	}

	try_publish(packet: PublishPacket) {
		if(!this.mqtt)
			return

		for(const [k, v] of this.subscriptions) {
			if(v.match(packet.topic)) {
				this.mqtt.publish(packet)
				return
			}
		}
	}
}

type BrokerEvents = {
	connect: (packet: IConnectPacket, client: Client) => void
	disconnect: (client: Client) => void
	publish: (packet: PublishPacket, client: Client | null) => void
}

export class Broker extends TypedEmitter<BrokerEvents> {
	clients = new Set<Client>();
	retainMap = new Map<String, PublishPacket>();

	constructor() {
		super()
	}

	accept(stream: Socket) {
		const mqtt = newMqttConnection(stream)
		const client = new Client(mqtt, this.retainMap)

		mqtt.on('publish', (packet) => {
			this.publish(packet, client)

			if(packet.qos > 0)
				mqtt.puback({messageId: packet.messageId})
		})
		
		mqtt.on('connect', (packet) => this.emit('connect', packet, client))

		this.clients.add(client)

		stream.setTimeout(1000*60*5)
		stream.on('timeout', function() { client.destroy() })

		client.on('destroy', (lwt: LWT) => {
			if(lwt)
				this.publish({ 
					qos: 0,
					dup: false,
					retain: false,
					topic: lwt.topic,
					payload: lwt.payload
				}, client)

			this.emit('disconnect', client)
			this.clients.delete(client)
		})
	}

	publish(packet: PublishPacket, client: Client|null) {
		this.emit('publish', packet, client)

		for (const ci of this.clients)
			ci.try_publish(packet)

		if(packet.retain) {
			if(packet.payload.length > 0) {
				// new retained topic
				this.retainMap.set(packet.topic, packet)
			} else {
				// delete retained topic
				this.retainMap.delete(packet.topic)
			}
		}
	}
}