export type TLV = {
	t: number,
	v: number
}

export function parse(buf: Buffer): TLV[] {
	const out: TLV[] = []
	for(var i=0;i < buf.length;) {
		if(i + 2 > buf.length) {
			return out
			throw new Error("TLV sequence truncated")
		}

		const t = (buf[i]<<2) + (buf[i+1]>>6)
		const l = ((buf[i+1]>>4)&3)
		let v = (buf[i+1]&15)

		if(i + 2 + l > buf.length) {
			return out
			throw new Error("TLV sequence truncated")
		}

		if(l > 0) {
			v = 0;
			for(var j=0;j<l;j++)
				v = (v<<8)|buf[i+2+j]
		}
		out.push({ t, v })
		i += 2 + l	
	}
	return out
}

export function build(elements: TLV[]): number[] {
	let out = []
	elements.forEach((el) => {
		let t0 = (el.t>>2) & 255
		out.push(t0)
		let tl = ((el.t&3)<<6)

		if(el.v < 0x10) {
			out.push(tl | el.v)
		} else if(el.v < 0x100) {
			out.push(tl | 0x10)
			out.push(el.v)
		} else if(el.v < 0x10000) {
			out.push(tl | 0x20)
			out.push((el.v>>8)&0xff)
			out.push((el.v)&0xff)
		} else {
			out.push(tl | 0x30)
			out.push((el.v>>16)&0xff)
			out.push((el.v>>8)&0xff)
			out.push((el.v)&0xff)
		}
	})
	return out
}