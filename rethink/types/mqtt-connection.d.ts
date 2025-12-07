declare module 'mqtt-connection' {
    import type { IConnackPacket, IDisconnectPacket, IPingreqPacket, IPubackPacket, IPublishPacket, ISubackPacket, ISubscribePacket, IUnsubackPacket, IUnsubscribePacket, IConnectPacket } from 'mqtt-packet';
    import { Duplex } from "node:stream";
    import EventEmitter from 'node:events'

    const connect: 
        | ((stream: Duplex, options?: object, callback?: () => void) => MqttConnection)
        | ((stream: Duplex, callback?: () => void) =>  MqttConnection);

    export interface MqttConnection extends EventEmitter {
        connect: (arg: Omit<IConnectPacket, 'cmd'>) => void;
        connack: (arg: Omit<IConnackPacket, 'cmd'>) => void;
        publish: (arg: Omit<IPublishPacket, 'cmd'>) => void;
        puback: (arg: Omit<IPubackPacket, 'cmd'>) => void;
        pingresp: (arg: Omit<IPingreqPacket, 'cmd'>) => void;
        subscribe: (arg: Omit<ISubscribePacket, 'cmd'>) => void;
        suback: (arg: Omit<ISubackPacket, 'cmd'>) => void;
        unsubscribe: (arg: Omit<IUnsubscribePacket, 'cmd'>) => void;
        unsuback: (arg: Omit<IUnsubackPacket, 'cmd'>) => void;
        disconnect: (arg: Omit<IDisconnectPacket, 'cmd'>) => void;

        destroy: () => void;
    }

    export default connect;
}