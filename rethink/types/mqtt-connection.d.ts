declare module 'mqtt-connection' {
    import { type TypedEmitter } from 'tiny-typed-emitter';

    import type { IConnackPacket, IDisconnectPacket, IPingreqPacket, IPubackPacket, IPublishPacket, ISubackPacket, ISubscribePacket, IUnsubackPacket, IUnsubscribePacket, IConnectPacket, IPingrespPacket } from 'mqtt-packet';
    import { Duplex } from "node:stream";

    const connect: 
        | ((stream: Duplex, options?: object, callback?: () => void) => MqttConnection)
        | ((stream: Duplex, callback?: () => void) =>  MqttConnection);

    type MqttEvents = {
        connect: (arg: IConnectPacket) => void;
        connack: (arg: IConnackPacket) => void;
        publish: (arg: IPublishPacket) => void;
        puback: (arg: IPubackPacket) => void;
        pingreq: (arg: IPingreqPacket) => void;
        subscribe: (arg: ISubscribePacket) => void;
        suback: (arg: ISubackPacket) => void;
        unsubscribe: (arg: IUnsubscribePacket) => void;
        unsuback: (arg: IUnsubackPacket) => void;
        disconnect: (arg: IDisconnectPacket) => void;
        close: () => void;
        error: (error: Error) => void;
    }

    export interface MqttConnection extends TypedEmitter<MqttEvents> {
        connect: (arg: Omit<IConnectPacket, 'cmd'>) => void;
        connack: (arg: Omit<IConnackPacket, 'cmd'>) => void;
        publish: (arg: Omit<IPublishPacket, 'cmd'>) => void;
        puback: (arg: Omit<IPubackPacket, 'cmd'>) => void;
        pingresp: (arg: Omit<IPingrespPacket, 'cmd'>) => void;
        subscribe: (arg: Omit<ISubscribePacket, 'cmd'>) => void;
        suback: (arg: Omit<ISubackPacket, 'cmd'>) => void;
        unsubscribe: (arg: Omit<IUnsubscribePacket, 'cmd'>) => void;
        unsuback: (arg: Omit<IUnsubackPacket, 'cmd'>) => void;
        disconnect: (arg: Omit<IDisconnectPacket, 'cmd'>) => void;

        destroy: () => void;
    }

    export default connect;
}