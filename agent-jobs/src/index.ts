import path from "path";
import os from "os";
import fs from "fs";
import axios from "axios";
import { io, Socket } from 'socket.io-client'
import https from 'https'
import { spawn } from "child_process"
import { Octokit } from "@octokit/rest"
import yaml from 'yaml'
import pg from 'pg'
const { Pool } = pg

let jobData = process.env.JOB_DATA!!;

let deploymentRunId: any
let services: any
let repository: any
let latestDeployRun: any

try {

    if (!process.env.JOB_DATA) {
        console.error('JOB_DATA environment variable is not set')
        process.exit(1)
    }

    const parsedJobData = JSON.parse(Buffer.from(process.env.JOB_DATA!!, 'base64').toString())
    deploymentRunId = parsedJobData.deploymentRunId
    services = parsedJobData.services
    repository = parsedJobData.repository
    latestDeployRun = parsedJobData.latestDeployRun
} catch (error) {
    console.error('Failed to parse job data:', error)
    process.exit(1)
}

const pool = new Pool({
    host: process.env.POSTGRES_HOST,
    database: process.env.POSTGRES_DB,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    port: process.env.POSTGRES_PORT ? parseInt(process.env.POSTGRES_PORT) : 5432,
})

async function getDbConnection() {
    return await pool.connect()
}

let socket: Socket | null = null

interface AWSRepository {
    name: string
    regions: string[]
    branch: string
    valueFile: {
        source: string
        bucket?: string
    }
}

if (process.env.GRAVITY_API_KEY) {
    socket = io(process.env.GRAVITY_WEBSOCKET_URL, {
        transports: ['websocket'],
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
        timeout: 10000,
        auth: {
            gravityApiKey: process.env.GRAVITY_API_KEY
        }
    })

    socket.on('connect', () => {
        console.log("Socket.IO connection opened")
    })

    socket.on('connect_error', (error: any) => {
        console.error(`Socket.IO connection error: ${error}`)
        console.error(`Error details: ${JSON.stringify(error)}`)
    })

    socket.on('disconnect', (reason: any) => {
        console.log(`Socket.IO connection closed: ${reason}`)
    })

    socket.on('reconnect_attempt', (attemptNumber: number) => {
        console.log(`Socket.IO reconnection attempt ${attemptNumber}`)
    })

    socket.on('reconnect_failed', () => {
        console.error("Socket.IO failed to reconnect after all attempts")
    })
}

const sendSlackNotification = async (title: string, message: string) => {
    if (!process.env.SLACK_WEBHOOK_URL) {
        console.log("Slack webhook URL not found, skipping notification")
        return
    }
    const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL
    await axios.post(slackWebhookUrl, { text: `*${title}*\n${message}` })
}

const syncArgoCD = async (appName: string, argoCDUrl: string, token: string) => {
    const url = `${argoCDUrl}/api/v1/applications/${appName}?refresh=hard`
    try {
        const response = await axios.get(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            httpsAgent: new https.Agent({
                rejectUnauthorized: false
            })
        })
        console.log('Sync triggered successfully:', response.data)
    } catch (error) {
        console.error('Failed to trigger sync:', error)
    }
}

const updateImageTag = (obj: any, newTag: string): boolean => {
    if (typeof obj !== 'object' || obj === null) return false;

    let updated = false;
    for (const key in obj) {
        if (key === 'image' && typeof obj[key] === 'object' && 'tag' in obj[key]) {
            obj[key].tag = newTag;
            updated = true;
        } else if (typeof obj[key] === 'object') {
            updated = updateImageTag(obj[key], newTag) || updated;
        }
    }
    return updated;
};

const findFile = (dir: string, fileName: string): string | null => {
    const files = fs.readdirSync(dir)
    for (const file of files) {
        const filePath = path.join(dir, file)
        const stat = fs.statSync(filePath)
        if (stat.isDirectory()) {
            const found = findFile(filePath, fileName)
            if (found) return found
        } else if (file === fileName) {
            return filePath
        }
    }
    return null
}

const downloadFile = async (file: any, path: string, githubToken: string) => {
    if (file.type === "file") {
        const fileContent = await axios.get(file.download_url, {
            headers: {
                "Authorization": `Bearer ${githubToken}`
            },
            responseType: 'text'
        })
        fs.writeFileSync(path, fileContent.data)
    } else if (file.type === "dir") {
        fs.mkdirSync(path, { recursive: true })
        const dirContent = await axios.get(file.url, {
            headers: {
                "Authorization": `Bearer ${githubToken}`
            }
        })
        await Promise.all(dirContent.data.map((item: any) =>
            downloadFile(item, `${path}/${item.name}`, githubToken)
        ))
    }
}

const syncLogsToGravityViaWebsocket = async (runId: string, action: string, message: string, isError: boolean = false) => {
    if (socket && socket.connected) {
        socket.emit('log', { runId, action, message, gravityApiKey: process.env.GRAVITY_API_KEY, timestamp: new Date().toISOString(), isError })
    }
}

const customExec = (runId: string, action: string, command: string, skipLogging: boolean = false): Promise<string> => {
    return new Promise((resolve, reject) => {

        const cleanedCommand = command.replace(/(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|DOCKER_USERNAME)=[^\s]*/g, "$1=****").replace(/x-access-token:[^@]*@/g, "x-access-token:****@")
        console.log(`Executing command: ${cleanedCommand}`)
        const process = spawn(command, [], { shell: true })

        let output = ''

        const handleOutput = (data: Buffer) => {
            const chunk = data.toString().trim()
            output += chunk + '\n'
            console.log(chunk)
            if (!skipLogging) {
                if (chunk) {
                    syncLogsToGravityViaWebsocket(runId, action, JSON.stringify(chunk), false)
                }
            }
        }

        process.stdout.on('data', (data) => handleOutput(data))
        process.stderr.on('data', (data) => handleOutput(data))

        process.on('error', (error) => {
            console.error(error)
            syncLogsToGravityViaWebsocket(runId, action, JSON.stringify(error.message), true)
            reject(error)
        })

        process.on('close', (code) => {
            console.log(`Process exited with code: ${code}`)
            if (code !== 0) {
                const error = new Error(`Process exited with code: ${code}`)
                console.error(error)
                syncLogsToGravityViaWebsocket(runId, action, JSON.stringify(error.message), true)
                reject(error)
            } else {
                resolve(output)
            }
        })
    })
}

const processJob = async () => {

    if (jobData) {

        let client: pg.PoolClient | null = null
        try {
            const githubToken = process.env.GITHUB_TOKEN!!

            const octokit = new Octokit({ auth: githubToken })

            client = await getDbConnection()

            const [owner, repo] = repository.split('/')

            for (const service of services) {
                try {
                    if (!service.hasChanges) {
                        console.log(`No changes found for service ${service.servicePath}, skipping`)
                        return
                    }

                    const serviceName = service.servicePath === '.' ?
                        service.gravityConfig.metadata.name :
                        path.basename(service.servicePath)

                    // Clone repository
                    const tempDir = os.tmpdir()
                    const gitRepoPath = path.join(tempDir, `${repository.replace('/', '-')}-${serviceName}`)

                    // Clean up existing directory if it exists
                    if (fs.existsSync(gitRepoPath)) {
                        fs.rmSync(gitRepoPath, { recursive: true, force: true })
                    }

                    // Create fresh directory
                    fs.mkdirSync(gitRepoPath, { recursive: true })

                    const cloneUrl = `https://x-access-token:${githubToken}@github.com/${repository}.git`
                    await customExec(deploymentRunId, "GIT_CLONE", `git clone ${cloneUrl} ${gitRepoPath}`)

                    const lastRunBranch = latestDeployRun.head_branch

                    if (service.gravityConfig?.spec?.preDeploy) {
                        await Promise.all(service.gravityConfig?.spec?.preDeploy?.map(async (preDeployStep: any) => {
                            sendSlackNotification("Running Pre Deploy Command", `${preDeployStep.command} for ${serviceName} / ${lastRunBranch} in ${repository}`)
                            await customExec(deploymentRunId, "PRE_DEPLOY_STEP", `cd ${gitRepoPath} && ${preDeployStep.command}`)
                        }))
                    }

                    sendSlackNotification("Docker Build Started", `Docker build started for ${serviceName} / ${lastRunBranch} in ${repository}`)

                    // Build Docker image
                    let dockerBuildCli = process.env.ENV === "production" ? "buildah --storage-driver vfs" : "docker"
                    const serviceContext = path.join(gitRepoPath, service.servicePath)
                    const dockerfilePath = path.join(serviceContext, 'Dockerfile')

                    const dockerBuildCommand = `${dockerBuildCli} ${process.env.ENV === "production" ? "bud --isolation chroot" : "build"} --platform=linux/amd64 -t ${owner}/${serviceName}:latest -f ${dockerfilePath} ${serviceContext}`

                    await customExec(deploymentRunId, "DOCKER_IMAGE_BUILD", dockerBuildCommand)

                    sendSlackNotification("Docker Build Completed", `Docker build completed for ${serviceName} / ${lastRunBranch} in ${repository}`)

                    // Continue with existing AWS deployment logic
                    const newValuesFiles: string[] = []

                    if (service.gravityConfig?.spec?.aws) {
                        // push the docker image for each aws repository
                        await Promise.all(service.gravityConfig?.spec?.aws?.repository?.map(async (repoDetails: AWSRepository) => {
                            try {
                                const awsRepositoryName = repoDetails?.name
                                const awsRepositoryRegions = repoDetails?.regions
                                const awsRepositoryBranch = repoDetails?.branch

                                // check if the branch is the same as the last run branch
                                if (awsRepositoryBranch !== lastRunBranch) {
                                    // check if the branch is a wildcard pattern
                                    if (awsRepositoryBranch.endsWith('.*')) {
                                        // convert wildcard pattern to regex
                                        const prefix = awsRepositoryBranch.slice(0, -2)
                                        const pattern = new RegExp(`^${prefix}.*$`)
                                        if (!pattern.test(lastRunBranch)) {
                                            console.log(`Branch ${lastRunBranch} does not match pattern ${awsRepositoryBranch}, skipping deployment`)
                                            return
                                        }
                                    } else {
                                        console.log(`Branch ${lastRunBranch} does not match ${awsRepositoryBranch}, skipping deployment`)
                                        return
                                    }
                                }

                                await Promise.all(awsRepositoryRegions.map(async (region) => {
                                    try {
                                        const ecrBaseURL = `${process.env.AWS_ACCOUNT_ID}.dkr.ecr.${region}.amazonaws.com`

                                        // check if the ecr repository exists, if not create it
                                        try {
                                            await customExec(deploymentRunId, "ECR_REPOSITORY_CHECK", `AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID} AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY} aws ecr describe-repositories --repository-names ${awsRepositoryName} --region ${region}`)
                                        } catch (error) {
                                            console.error(`Error checking if repository ${awsRepositoryName} exists: ${error}`)
                                            console.log("Creating repository...")
                                            await customExec(deploymentRunId, "ECR_REPOSITORY_CREATE", `AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID} AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY} aws ecr create-repository --repository-name ${awsRepositoryName} --region ${region}`)
                                        }

                                        const imageTag = `${latestDeployRun.head_sha?.slice(0, 7)}-${lastRunBranch}`

                                        // tag the docker image with the aws repository name and region
                                        const dockerTagCommand = `${dockerBuildCli} tag ${owner}/${serviceName}:latest ${ecrBaseURL}/${awsRepositoryName}:${imageTag}`
                                        await customExec(deploymentRunId, "DOCKER_IMAGE_TAG", dockerTagCommand)

                                        const dockerPushCommand = `AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID} AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY} aws ecr get-login-password --region ${region} | ${dockerBuildCli} login --username AWS --password-stdin ${ecrBaseURL} && ${dockerBuildCli} push ${ecrBaseURL}/${awsRepositoryName}:${imageTag}`
                                        await customExec(deploymentRunId, "DOCKER_IMAGE_PUSH", dockerPushCommand)

                                        await customExec(deploymentRunId, "DOCKER_LOGOUT", `${dockerBuildCli} logout ${ecrBaseURL}`)

                                        sendSlackNotification("Docker Push Completed", `Docker push completed for ${serviceName} / ${lastRunBranch} in ${repository} at ${region}}`)

                                        if (repoDetails?.valueFile?.source === "git") {
                                            const valueFileName = `${serviceName}-values-${lastRunBranch}-${region}.yaml`

                                            try {
                                                let valuesFilePath = findFile(path.join(gitRepoPath, service.servicePath), valueFileName)

                                                if (!valuesFilePath) {
                                                    console.error(`Values file ${valueFileName} not found`)
                                                    return
                                                }

                                                const valuesFileContent = fs.readFileSync(valuesFilePath, 'utf8')

                                                const parsedValuesFile = yaml.parse(valuesFileContent);
                                                if (!updateImageTag(parsedValuesFile, imageTag)) {
                                                    console.error('Error: No image.tag pattern found in values file');
                                                    return
                                                }

                                                const relativePath = path.relative(gitRepoPath, valuesFilePath)

                                                // Fetch the current file to get its SHA
                                                const { data: currentFile } = await octokit.repos.getContent({
                                                    owner,
                                                    repo,
                                                    path: relativePath,
                                                    ref: lastRunBranch
                                                })

                                                if (Array.isArray(currentFile)) {
                                                    console.error(`${relativePath} is a directory, not a file`)
                                                    return
                                                }

                                                // this method does not trigger workflow dispatch event
                                                await octokit.repos.createOrUpdateFileContents({
                                                    owner,
                                                    repo,
                                                    path: relativePath,
                                                    message: `[skip ci] Updated values file for ${lastRunBranch} in ${region} for deployment ${latestDeployRun.id}`,
                                                    content: Buffer.from(yaml.stringify(parsedValuesFile)).toString('base64'),
                                                    sha: currentFile.sha,
                                                    branch: lastRunBranch
                                                })

                                                console.log(`Updated ${valueFileName} for ${lastRunBranch} in ${region}`)
                                                sendSlackNotification("Values File Updated", `Updated ${valueFileName} for ${serviceName} / ${lastRunBranch} in ${repository} at ${region}`)

                                                newValuesFiles.push(JSON.stringify({ name: valueFileName, previousContent: valuesFileContent, newContent: yaml.stringify(parsedValuesFile) }))
                                            } catch (error) {
                                                console.error(`Error updating ${valueFileName}: ${error}`)
                                                await client?.query("UPDATE deployments SET status = $1 WHERE runId = $2", ["FAILED", deploymentRunId])
                                                syncLogsToGravityViaWebsocket(deploymentRunId, "PIPELINE_FAILED", JSON.stringify({ error: error.message }), true)
                                                sendSlackNotification("Values File Update Failed", `Error updating ${valueFileName} for ${serviceName} / ${lastRunBranch} in ${repository} at ${region}: ${error}`)
                                            }
                                        } else if (repoDetails?.valueFile?.source === "s3") {
                                            try {
                                                let valueFilesPath = repoDetails?.valueFile?.bucket
                                                let s3BucketName = valueFilesPath
                                                let s3Prefix = ''

                                                if (valueFilesPath?.includes('/')) {
                                                    const parts = valueFilesPath.split('/')
                                                    s3BucketName = parts[0]

                                                    const processedParts = parts.slice(1).map(part => {
                                                        if (part.endsWith('.*')) {
                                                            return lastRunBranch
                                                        }
                                                        return part
                                                    })

                                                    s3Prefix = processedParts.join('/')
                                                }

                                                let latestValueFileFromS3Bucket = await customExec(deploymentRunId, "UPDATING_VALUES_FILE", `AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID} AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY} aws s3api list-objects-v2 --bucket ${s3BucketName} ${s3Prefix ? `--prefix ${s3Prefix}` : ''} --query 'sort_by(Contents, &LastModified)[-1].Key' --output text`, true)
                                                if (!latestValueFileFromS3Bucket) {
                                                    console.error(`No value file found in ${valueFilesPath}`)
                                                    return
                                                }

                                                latestValueFileFromS3Bucket = latestValueFileFromS3Bucket.trim()

                                                const tempDir = os.tmpdir()
                                                const localFilePath = path.join(tempDir, path.basename(latestValueFileFromS3Bucket))

                                                await customExec(deploymentRunId, "UPDATING_VALUES_FILE", `AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID} AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY} aws s3 cp s3://${s3BucketName}/${s3Prefix ? `${s3Prefix}/` : ''}${path.basename(latestValueFileFromS3Bucket)} ${localFilePath}`, true)

                                                const valuesFileContent = fs.readFileSync(localFilePath, 'utf8')

                                                if (!valuesFileContent) {
                                                    console.error(`Error getting values file content from ${valueFilesPath}`)
                                                    return
                                                }

                                                let parsedValuesFile = yaml.parse(valuesFileContent)
                                                parsedValuesFile.image.tag = imageTag

                                                // create a temporary file with the new values file content with same name as the original one
                                                fs.writeFileSync(localFilePath, yaml.stringify(parsedValuesFile))

                                                // upload the temporary file to the s3 bucket
                                                try {
                                                    console.log(`Updating S3 file: ${s3BucketName}/${s3Prefix ? `${s3Prefix}/` : ''}${latestValueFileFromS3Bucket}`)

                                                    // First, delete the existing file
                                                    console.log(`Deleting existing S3 file: ${s3BucketName}/${s3Prefix ? `${s3Prefix}/` : ''}${latestValueFileFromS3Bucket}`)

                                                    const s3DeleteCommand = `AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID} AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY} aws s3 rm s3://${s3BucketName}/${s3Prefix ? `${s3Prefix}/` : ''}${path.basename(latestValueFileFromS3Bucket)}`
                                                    await customExec(deploymentRunId, "DELETING_S3_FILE", s3DeleteCommand, true)
                                                    console.log(`Successfully deleted existing S3 file: ${s3BucketName}/${s3Prefix ? `${s3Prefix}/` : ''}${path.basename(latestValueFileFromS3Bucket)}`)

                                                    // Then, upload the new file
                                                    console.log(`Uploading new S3 file: ${s3BucketName}/${s3Prefix ? `${s3Prefix}/` : ''}${path.basename(latestValueFileFromS3Bucket)}`)

                                                    const s3UploadCommand = `AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID} AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY} aws s3 cp ${localFilePath} s3://${s3BucketName}/${s3Prefix ? `${s3Prefix}/` : ''}${path.basename(latestValueFileFromS3Bucket)}`
                                                    await customExec(deploymentRunId, "UPLOADING_S3_FILE", s3UploadCommand, true)
                                                    console.log(`Successfully uploaded new values file to S3 bucket: ${s3BucketName}/${s3Prefix ? `${s3Prefix}/` : ''}${path.basename(latestValueFileFromS3Bucket)}`)

                                                    sendSlackNotification("S3 Values File Updated", `Updated ${path.basename(latestValueFileFromS3Bucket)} for ${serviceName} / ${lastRunBranch} in ${repository} at ${region}`)

                                                } catch (error) {
                                                    console.error(`Failed to update values file in S3 bucket: ${error}`)
                                                    await client?.query("UPDATE deployments SET status = $1 WHERE runId = $2", ["FAILED", deploymentRunId])
                                                    syncLogsToGravityViaWebsocket(deploymentRunId, "PIPELINE_FAILED", JSON.stringify({ error: `S3 file update failed: ${error.message}` }), true)
                                                    sendSlackNotification("Values File Update Failed", `Error updating values file in S3 bucket for ${lastRunBranch} in ${region}: ${error}`)
                                                    throw error
                                                }

                                                newValuesFiles.push(JSON.stringify({ name: path.basename(latestValueFileFromS3Bucket), previousContent: valuesFileContent, newContent: yaml.stringify(parsedValuesFile) }))

                                                // delete the temporary file
                                                fs.unlinkSync(localFilePath)

                                                await syncArgoCD(serviceName, process.env.ARGOCD_URL!!, process.env.ARGOCD_TOKEN!!)
                                                sendSlackNotification("ArgoCD Synced", `ArgoCD synced for ${serviceName} in ${repository} at ${region}`)

                                            } catch (error) {
                                                console.error(`Error updating ${repoDetails?.valueFile?.bucket}: ${error}`)
                                                await client?.query("UPDATE deployments SET status = $1 WHERE runId = $2", ["FAILED", deploymentRunId])
                                                syncLogsToGravityViaWebsocket(deploymentRunId, "PIPELINE_FAILED", JSON.stringify({ error: error.message }), true)
                                                sendSlackNotification("S3 File Update Failed", `Error updating ${repoDetails?.valueFile?.bucket} for ${lastRunBranch} in ${region}: ${error}`)
                                            }
                                        }

                                    } catch (error) {
                                        console.error(`Error processing region ${region}: ${error}`)
                                        await client?.query("UPDATE deployments SET status = $1 WHERE runId = $2", ["FAILED", deploymentRunId])
                                        syncLogsToGravityViaWebsocket(deploymentRunId, "PIPELINE_FAILED", JSON.stringify({ error: error.message }), true)
                                        sendSlackNotification("Deployment Failed", `Error processing region ${region} for ${repository}: ${error}`)
                                    }
                                }))
                            } catch (error) {
                                console.error(`Error processing AWS repository ${repoDetails.name}: ${error}`)
                                console.error('Stack trace:', error.stack)
                                await client?.query("UPDATE deployments SET status = $1 WHERE runId = $2", ["FAILED", deploymentRunId])
                                syncLogsToGravityViaWebsocket(deploymentRunId, "PIPELINE_FAILED", JSON.stringify({ error: error.message }), true)
                                sendSlackNotification("Deployment Failed", `Error processing AWS repository ${repoDetails.name} for ${repository}: ${error}`)
                            }
                        }))
                    }

                    // Update deployment status
                    await client?.query(
                        "UPDATE deployments SET values_files = $1, status = $2 WHERE runId = $3",
                        [JSON.stringify(newValuesFiles), "COMPLETED", deploymentRunId]
                    )

                    syncLogsToGravityViaWebsocket(deploymentRunId, "PIPELINE_COMPLETED", JSON.stringify({ newValuesFiles }), false)

                    // Cleanup
                    if (fs.existsSync(gitRepoPath)) {
                        fs.rmSync(gitRepoPath, { recursive: true, force: true })
                    }
                } catch (error) {
                    console.error(`Error processing service ${service.servicePath}: ${error}`)
                    await client?.query("UPDATE deployments SET status = $1 WHERE runId = $2", ["FAILED", deploymentRunId])
                    syncLogsToGravityViaWebsocket(deploymentRunId, "PIPELINE_FAILED", JSON.stringify({ error: error.message }), true)
                    sendSlackNotification("Deployment Failed", `Error processing service ${service.servicePath} for ${repository}: ${error}`)
                }
            }


        } catch (error) {
            console.error(`Error parsing job data: ${error}`)
            throw error
        }
    }
}

processJob().catch((error) => {
    console.error('Unhandled error:', error);
});

const cleanup = async () => {
    let client: pg.PoolClient | null = null
    try {
        client = await pool.connect()
        await client?.query("UPDATE deployments SET status = $1 WHERE runId = $2", ["FAILED", deploymentRunId])
        syncLogsToGravityViaWebsocket(deploymentRunId, "PIPELINE_FAILED", JSON.stringify({ error: "Pod termination" }), true)
    } finally {
        client?.release()
    }
    process.exit(0);
};

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);