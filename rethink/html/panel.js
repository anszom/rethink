document.addEventListener('DOMContentLoaded', function() {
    M.Tooltip.init(document.querySelectorAll('.tooltipped'));
});

let ws
let reconnectTimer
const STATUS_OK=`<i class="tiny material-icons green-text">check</i>`
const STATUS_ERROR=`<i class="tiny material-icons red-text">error</i>`
const STATUS_UNKNOWN=`<i class="tiny material-icons red-text">question_mark</i>`

get("status_rethink").innerHTML = STATUS_UNKNOWN
get("status_mqtt").innerHTML = STATUS_UNKNOWN

const devices = {}

const baseUrl = new URL(window.location)
baseUrl.pathname = '/'
baseUrl.search = ''
baseUrl.hash = ''

class DeviceEntry {
    constructor(id, remoteState, parent) {
        this.id = id
        this.remoteState = remoteState
        this.row = document.createElement('tr')
        this.updateDom();
        parent.appendChild(this.row)
    }

    destroy() {
        this.row.remove()
    }

    update(remoteState) {
        this.remoteState = remoteState
        this.updateDom();
    }

    updateDom() {
        const children = []

        let td
        td = document.createElement('td')
        td.innerText = this.id
        children.push(td)

        td = document.createElement('td')
        let model = this.remoteState.model
        if(!this.remoteState.mapped) {
            model += ` <i class="material-icons tooltipped tiny" data-position="bottom" data-tooltip="This device is not supported by rethink. It will not be mapped to HomeAssistant">warning</i>`
        }
        td.innerHTML = model
        children.push(td)

        td = document.createElement('td')
        td.innerText = this.remoteState.platform
        children.push(td)

        this.row.replaceChildren(...children)
        Array.from(this.row.getElementsByClassName('tooltipped')).forEach((e) => M.Tooltip.init(e))
    }
}

function connect() {
    clearTimeout(reconnectTimer)
    let ws = new WebSocket(baseUrl + 'ws')

    ws.onclose = () => {
        get("status_rethink").innerHTML = STATUS_ERROR
        get("status_mqtt").innerHTML = STATUS_UNKNOWN
        document.getElementsByTagName('body')[0].classList.add('offline')
        reconnectTimer = setTimeout(connect, 5000)
    }

    ws.onopen = () => {
        get("status_rethink").innerHTML = STATUS_OK
        document.getElementsByTagName('body')[0].classList.remove('offline')
    }

    ws.onmessage = (ev) => {
        if(typeof(ev.data) === 'string') {
            const json = JSON.parse(ev.data)
            if(typeof(json.ha) === 'boolean') {
                get("status_mqtt").innerHTML = json.ha ? STATUS_OK : STATUS_ERROR
            }

            if(typeof(json.devices) === 'object') {
                let deletedDevices = Object.keys(devices).filter((id) => !json.devices[id])
                deletedDevices.forEach((id) => {
                    devices[id].destroy()
                    delete devices[id]
                })

                for(const id in json.devices) {
                    const j = json.devices[id]

                    if(!devices[id])
                        devices[id] = new DeviceEntry(id, j, get('devices_body'))
                    else
                        devices[id].update(j)
                }
            }

            if(typeof(json.status) === 'string') {
              M.toast({html: json.status})
            }
        }
    }
}

function get(id) {
    return document.getElementById(id)
}

connect()