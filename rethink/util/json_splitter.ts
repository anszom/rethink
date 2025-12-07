export default function() {
	let state = 0
	let depth = 0
	let buf = []
	return function(byte: number, callback: (unknown)=>void) {
		buf.push(byte)

		if(state == 0) {
			if(byte == 0x5b || byte == 0x7b) { // [ {
				depth++
			}

			if(byte == 0x5d || byte == 0x7d) { // ] }
				depth--
				if(depth < 0)
					throw new Error("Invalid JSON: too many closing tokens")

				if(depth == 0) {
					callback(JSON.parse(Buffer.from(buf).toString('utf-8')))
					buf = []
				}
			}

			if(byte == 0x22) { // "
				state = 1
			}

		} else if(state == 1) {
			if(byte == 0x22) { // "
				state = 0
			}

			if(byte == 0x5c) { // \
				state = 2;
			}

		} else if(state == 2) {
			state = 1;
		}
	}
}

