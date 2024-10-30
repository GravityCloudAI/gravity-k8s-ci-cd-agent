import axios from "axios"
import https from 'https'

export async function syncArgoCD(appName: string, argoCDUrl: string, token: string) {
    const url = `${argoCDUrl}/api/v1/applications/${appName}?refresh=hard`
    try {
        const response = await axios.get(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            httpsAgent: new https.Agent({  // Add this option
                rejectUnauthorized: false
            })
        })
        console.log('Sync triggered successfully:', response.data)
    } catch (error) {
        console.error('Failed to trigger sync:', error)
    }
}