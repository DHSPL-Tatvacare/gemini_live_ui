import {GoogleGenAI} from '@google/genai'

const API_KEY = import.meta.env.VITE_API_KEY?.trim()

export async function generateEphemeralToken({
	                                             uses = 0,
	                                             expireMinutes = 1140,
	                                             newSessionExpireMinutes = 1140
                                             } = {}) {
	if (!API_KEY) {
		throw new Error('Missing VITE_API_KEY. Set it in the project .env file.')
	}
	
	const client = new GoogleGenAI({
		apiKey: API_KEY,
		apiVersion: 'v1alpha'
	})
	
	return client.authTokens.create({
		config: {
			uses,
			expireTime: new Date(Date.now() + expireMinutes * 60 * 1000).toISOString(),
			newSessionExpireTime: new Date(
				Date.now() + newSessionExpireMinutes * 60 * 1000
			).toISOString()
		}
	})
}
