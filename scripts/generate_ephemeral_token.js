import {pathToFileURL} from 'node:url'
import {generateEphemeralToken} from '../src/lib/ephemeral-token.js'

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	const token = await generateEphemeralToken()
	console.log(token.name)
}
