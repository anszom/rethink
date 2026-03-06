document.addEventListener('DOMContentLoaded', function() {
    M.Tooltip.init(document.querySelectorAll('.tooltipped'));
    M.Modal.init(document.querySelectorAll('.modal'));
    M.FormSelect.init(document.querySelectorAll('select'));
    M.Autocomplete.init(document.querySelectorAll('.autocomplete'), {
        data: {
            '101 (Refrigerator)': null,
            '201 (Washer)': null,
            '401 (Air Conditioner)': null,
        }
    });
});

let ws
let reconnectTimer
const STATUS_OK=`<i class="tiny material-icons green-text">check</i>`
const STATUS_ERROR=`<i class="tiny material-icons red-text">error</i>`
const STATUS_UNKNOWN=`<i class="tiny material-icons red-text">question_mark</i>`
let bridge_status = false

get("status_rethink").innerHTML = STATUS_UNKNOWN
get("status_mqtt").innerHTML = STATUS_UNKNOWN
get("status_bridge").innerHTML = STATUS_UNKNOWN
get("status_bridge_text").innerText = 'Unknown'

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

        td = document.createElement('td')
        td.style='width: 10em';

        td.innerHTML=`
            <div class="switch">
                <label>Off <input type="checkbox"> <span class="lever"></span>On</label>
            </div>
            <div class="hide preloader-wrapper verysmall active">
                <div class="spinner-layer spinner-green-only">
                <div class="circle-clipper left">
                    <div class="circle"></div>
                </div><div class="gap-patch">
                    <div class="circle"></div>
                </div><div class="circle-clipper right">
                    <div class="circle"></div>
                </div>
                </div>
            </div>`
        children.push(td)

        this.bridgeSwitch = td.getElementsByTagName("input")[0]
        this.bridgeDiv = td.getElementsByClassName("switch")[0]
        this.spinner = td.getElementsByClassName("preloader-wrapper")[0]

        const startBridge = async (deviceType) => {
            this.bridgeBusy = true
            this.refreshUI()

            try {
                await fetchWrapper(`bridge/${this.id}/enable`, { deviceType }, { method: 'POST'})

            } finally {
                this.bridgeBusy = false
                this.refreshUI()
            }
        }

        const stopBridge = async () => {
            this.bridgeBusy = true
            this.refreshUI()

            try {
                await fetchWrapper(`bridge/${this.id}/disable`, {}, { method: 'POST'})

            } finally {
                this.bridgeBusy = false
                this.refreshUI()
            }
        }

        this.bridgeSwitch.onchange = () => {
            if(this.bridgeSwitch.checked) {
                if(this.remoteState.deviceType) {
                    startBridge(this.remoteState.deviceType)
                } else {
                    get("btn_devicetype_continue").onclick = () => {
                        let devType = get("devtype-input").value
                        devType = devType.split(" ")[0]
                        startBridge(devType)
                        M.Modal.getInstance(get('devicetype_query')).close();
                    }
                    M.Modal.getInstance(get('devicetype_query')).open();
                }
            } else {
                stopBridge();
            }
        }

        td = document.createElement('td')
        td.innerHTML=`<a class="btn waves-effect waves-light" href="/monitor?id=${this.id}"><i class="material-icons">troubleshoot</i></a>`
        children.push(td)

        this.row.replaceChildren(...children)
        Array.from(this.row.getElementsByClassName('tooltipped')).forEach((e) => M.Tooltip.init(e))
    }

    refreshUI() {
        if(this.bridgeBusy) {
            this.bridgeDiv.classList.add('hide')
            this.spinner.classList.remove('hide')
        } else {
            this.spinner.classList.add('hide')
            this.bridgeDiv.classList.remove('hide')
            this.bridgeSwitch.checked = !!this.remoteState.bridged
        }

        if(bridge_status) {
            this.bridgeSwitch.classList.remove('disabled')
        } else {
            this.bridgeSwitch.classList.add('disabled')
        }
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

            if(typeof(json.bridge) === 'object') {
                bridge_status = json.bridge.loggedIn
                if(json.bridge.loggedIn === true) {
                    document.getElementById("btn_thinq_login").classList.add('hide')
                    document.getElementById("btn_thinq_logout").classList.remove('hide')

                    get("status_bridge").innerHTML = STATUS_OK
                    get("status_bridge_text").innerText = 'Ok'
                } else {
                    document.getElementById("btn_thinq_login").classList.remove('hide')
                    document.getElementById("btn_thinq_logout").classList.add('hide')

                    get("status_bridge").innerHTML = STATUS_ERROR
                    get("status_bridge_text").innerText = 'Not configured'
                }

                for(const id in devices)
                    devices[id].refreshUI()
            }

            if(typeof(json.status) === 'string') {
              M.toast({html: json.status})
            }
        }
    }
}

get("btn_thinq_login_continue").onclick = () => {
    if(!get("country_code").validity.valid)
        return;

    const countryCode = get("country_code").value.toUpperCase()

    window.open(`${baseUrl}thinq_login?countryCode=${countryCode}`, '_blank')
}

get("btn_thinq_login_complete").onclick = async () => {
    if(!get("country_code").validity.valid)
        return;

    if(!get("login_url").validity.valid)
        return;

    const countryCode = get("country_code").value.toUpperCase()
    const url = get("login_url").value
    await fetchWrapper(`thinq_login_accept`, { url, countryCode }, { method: 'POST' })
    M.Modal.getInstance(get('thinq_login')).close();
}

get("btn_thinq_logout_continue").onclick = async () => {
    await fetchWrapper(`thinq_logout`, {}, { method: 'POST' })
    M.Modal.getInstance(get('thinq_logout')).close();
}

function get(id) {
    return document.getElementById(id)
}

async function fetchWrapper(path, body, options) {
    if(options.method !== 'GET') {
        if(!options.headers)
            options.headers = {}
        options.headers['Content-type'] = 'application/json'
    }
    options.body = JSON.stringify(body)
    try {
        const response = await fetch(`${baseUrl}${path}`, options)
        if(response.status >= 300)
            M.toast({html: `HTTP error ${response.status}: ${await response.text()}` })

        return response
    } catch(err) {
        M.toast({html: `FETCH error: ${err}`})
    }
}
connect()