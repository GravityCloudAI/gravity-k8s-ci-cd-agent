import axios from "axios"

export async function syncArgoCD(appName: string, argoCDUrl: string, token: string) {
    const url = `${argoCDUrl}/api/v1/applications/${appName}/sync`

    try {
        const response = await axios.post(url, {
            prune: true,
            refresh: "hard"
        }, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
        })
        console.log('Sync triggered successfully:', response.data)
    } catch (error) {
        console.error('Failed to trigger sync:', error)
    }
}