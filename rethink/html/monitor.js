document.addEventListener('DOMContentLoaded', function() {
});

let ws
let reconnectTimer

const baseUrl = new URL(window.location)
baseUrl.pathname = '/'
baseUrl.search = ''
baseUrl.hash = ''

get('device_id').innerText = new URLSearchParams(window.location.search).get('id')
get('device_status').innerText = 'Waiting for rethink connection...'

function connect() {
    clearTimeout(reconnectTimer)
    let ws = new WebSocket(baseUrl + `device${window.location.search}`)

    ws.onclose = () => {
        reconnectTimer = setTimeout(connect, 5000)
        get('device_status').innerText = 'Waiting for rethink connection...'
    }

    ws.onopen = () => {
        get('device_status').innerText = 'offline'
    }

    ws.onmessage = (ev) => {
        if(typeof(ev.data) === 'string') {
            const json = JSON.parse(ev.data)
            if(json.rx) {
                const div = pushMessage('rx', json.rx, json.injected)
                div.onclick = () => {
                    get('send2').value = json.rx
                    M.updateTextFields();
                }
            }

            if(json.tx) {
                const div = pushMessage('tx', json.tx, json.injected)
                div.onclick = () => {
                    get('send1').value = json.tx
                    M.updateTextFields();
                }
            }

            if(json.status) {
                get('device_status').innerText = json.status
                if(json.status === 'online') {
                    get("btn_send1").disabled = false
                    get("btn_send1").onclick = () => {
                        let cmd = get("send1").value
                        if(cmd[0] === '{')
                            cmd = JSON.parse(cmd)

                        ws.send(JSON.stringify({sendToDevice: cmd}))
                    }

                    get("btn_send2").disabled = false
                    get("btn_send2").onclick = () => {
                        ws.send(JSON.stringify({sendFromDevice: get("send2").value }))
                    }
                } else {
                    get("btn_send1").disabled = true
                    get("btn_send2").disabled = true
                }
            }

            if(json.meta) {
                get('device_model').innerText = json.meta.modelId
            }
        }
    }
}

function pushMessage(direction, payload, injected) {
    const timestamp = document.createElement('span')
    const messages = get('messages')

    timestamp.innerText = new Date().toLocaleTimeString()
    timestamp.classList.add('timestamp')
    const div = document.createElement('div')
    div.classList.add(direction, 'message')
    if(injected)
        div.classList.add('injected')
    div.innerText = payload
    div.appendChild(timestamp)

    messages.appendChild(div)

    if(get('autoscroll').checked)
        messages.scrollTop = messages.scrollHeight;

    return div
}

function get(id) {
    return document.getElementById(id)
}

connect()