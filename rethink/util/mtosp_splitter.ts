import crc16 from './crc16.js'

export default function() {
	let state = 0
	let prev = 0
	let total = 0
	let buf = []
    // 0xaa length:16 payload crc:16 0xbb
	return function(byte: number, callback: (string)=>void) {
        buf.push(byte)

		if(state == 0) {
			if(byte != 0xaa) 
				throw new Error("invalid header byte");
			state = 1;

		} else if(state == 1) {
			state = 2;

		} else if(state == 2) {
			total = byte | (prev<<8);
			state = 3;

		} else if(state == 3) {
			if(total > 0) {
				--total
			} else {
				state = 4;
			}
		} else if(state == 4) {
			if(crc16(buf) !== 0)
                throw new Error("invalid checksum");

			state = 5;
		} else if(state == 5) {
			if(byte != 0xbb)
				throw new Error("invalid trailer byte");
			state = 0;

			callback(Buffer.from(buf).subarray(3, buf.length-3).toString('utf-8'))
			buf = []
		}

        prev = byte;
	}
}

