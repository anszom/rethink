import type * as WS from 'ws'

declare module 'websocket-express' {
    /*
    TS in "bundler" resolution mode is more "lenient" and uses global `WebSocket` type instead of
    `WebSocket` imported from 'ws' inside this original module. This is because 'websocket-express' is
    importing `WebSocket` via namespace import and "bundler" mode in this case prefers global type.

    To fix this there is a need to force correct type with this module augmentation.
  */
    type WebSocket = WS.WebSocket
}
