"use strict"
import { Octokit } from "@octokit/rest"
import axios from "axios"
import path from "path";
import os from "os";
import fs from "fs";
import pg from 'pg'
import { io, Socket } from 'socket.io-client'
import { v4 } from 'uuid'
import yaml from 'yaml'
const { Pool } = pg
import redis from 'redis'
import { spawn } from "child_process"
import https from 'https'
import http from 'http';

interface ServiceChange {
	servicePath: string
	hasChanges: boolean
	gravityConfig?: any
	lastCommitSha?: string
}

interface ChartDetails {
	chartName: string,
	chartVersion: string,
	chartRepository: string,
	repositoryName: string,
	valuesFile: string
}

interface PipelineCharts {
	awsAccountId: string,
	charts: Array<ChartDetails>,
	branch: string
}

interface DeployRun {
	id: string;
	name: string;
	head_branch: string;
	head_sha: string;
	head_commit: any;
	status: string;
	actor: any;
	updated_at: string;
	run_attempt: number;
}

interface PostDeploy {
	name: string
	branches?: string[]
	once?: boolean
	command: string
	env?: {
		name: string
		value: string
	}[]
}

interface PreDeploy {
	name: string
	branches?: string[]
	once?: boolean
	command: string
}

interface Cleanup {
	name: string
	branches?: string[]
	command: string
}

interface CleanupMetadata {
	command: string;
	repository: string;
	owner: string;
	repo: string;
	branch: string;
	servicePath: string;
}

interface Action {
	name: string;
	uses: string;
	with: {
		version: string;
	}
}

const pool = new Pool({
	host: process.env.POSTGRES_HOST,
	database: process.env.POSTGRES_DB,
	user: process.env.POSTGRES_USER,
	password: process.env.POSTGRES_PASSWORD,
	port: process.env.POSTGRES_PORT ? parseInt(process.env.POSTGRES_PORT) : 5432,
})

const redisClient = redis.createClient({
	url: `redis://:${process.env.REDIS_PASSWORD}@${process.env.REDIS_HOST}:${process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379}`
})

const checkAndCreateDatabaseTables = async () => {
	(async () => {
		const client = await getDbConnection()
		try {
			const tableExistsQuery = `
				SELECT EXISTS (
					SELECT FROM information_schema.tables 
					WHERE table_name = 'deployments'
				)
			`
			const { rows } = await client.query(tableExistsQuery)
			if (!rows[0].exists) {
				console.log("Table 'deployments' does not exist, creating table")
				const createTableQuery = `
					CREATE TABLE deployments (
						runId TEXT PRIMARY KEY,
						actionId TEXT,
						commit_id TEXT,
						repository_name TEXT,
						service_path TEXT,
						commit_sha TEXT,
						branch TEXT,
						destinations TEXT,
						regions TEXT,
						values_files TEXT,
						status TEXT,
						user_id TEXT,
						user_details TEXT,
						created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
					)
				`
				await client.query(createTableQuery)
				console.log("Table 'deployments' created successfully")
			} else {
				console.log("Table 'deployments' already exists")
			}
		} catch (err) {
			console.error("Error checking or creating table:", err)
		} finally {
			client.release()
		}
	})();

	(async () => {
		const client = await getDbConnection()
		try {
			const tableExistsQuery = `
			SELECT EXISTS (
				SELECT FROM information_schema.tables 
				WHERE table_name = 'helm_deployments'
			)
		`
			const { rows } = await client.query(tableExistsQuery)
			if (!rows[0].exists) {
				console.log("Table 'helm_deployments' does not exist, creating table")
				const createTableQuery = `
				CREATE TABLE helm_deployments (
					runId TEXT PRIMARY KEY,
					branch TEXT,
					namespace TEXT,
					status TEXT,
					charts TEXT,
					updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
				)
			`
				await client.query(createTableQuery)
			} else {
				console.log("Table 'helm_deployments' already exists")
			}
		} catch (err) {
			console.error("Error checking or creating table:", err)
		} finally {
			client.release()
		}
	})();

	(async () => {
		const client = await getDbConnection()
		try {
			const tableExistsQuery = `
			SELECT EXISTS (
				SELECT FROM information_schema.tables 
				WHERE table_name = 'argo_deployments'
			)
		`
			const { rows } = await client.query(tableExistsQuery)
			if (!rows[0].exists) {
				console.log("Table 'argo_deployments' does not exist, creating table")
				const createTableQuery = `
				CREATE TABLE argo_deployments (
					runId TEXT PRIMARY KEY,
					branch TEXT,
					namespace TEXT,
					status TEXT,
					serviceName TEXT,
					valuesFile TEXT,
					updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
				)
			`
				await client.query(createTableQuery)
			} else {
				console.log("Table 'helm_deployments' already exists")
			}
		} catch (err) {
			console.error("Error checking or creating table:", err)
		} finally {
			client.release()
		}
	})();

	(async () => {
		const client = await getDbConnection()
		try {
			const tableExistsQuery = `
			SELECT EXISTS (
				SELECT FROM information_schema.tables 
				WHERE table_name = 'cleanup_deployments'
			)
		`
			const { rows } = await client.query(tableExistsQuery)
			if (!rows[0].exists) {
				console.log("Table 'cleanup_deployments' does not exist, creating table")
				const createTableQuery = `
				CREATE TABLE cleanup_deployments (
					branch TEXT PRIMARY KEY,
					metadata TEXT,
					post_deploy_out TEXT,
					updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
				)
			`
				await client.query(createTableQuery)
			} else {
				console.log("Table 'cleanup_deployments' already exists")
			}
		} catch (err) {
			console.error("Error checking or creating table:", err)
		} finally {
			client.release()
		}
	})();
}

let server: http.Server | null = null

const startServer = () => {
	const port = process.env.TRIGGER_PORT || 3000;

	server = http.createServer(async (req, res) => {
		// Only handle POST requests to /trigger
		if (req.method !== 'POST' || req.url !== '/trigger') {
			res.writeHead(404);
			res.end(JSON.stringify({ error: 'Not found' }));
			return;
		}

		try {
			let body = '';
			req.on('data', chunk => {
				body += chunk.toString();
			});

			req.on('end', async () => {
				try {
					const { repository, branch } = JSON.parse(body);

					if (!repository || !branch) {
						res.writeHead(400, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({
							error: 'Missing required parameters: repository, branch'
						}));
						return;
					}

					const result = await triggerDeployment(
						repository,
						branch
					);

					res.writeHead(200, {
						'Content-Type': 'application/json',
						'Access-Control-Allow-Origin': '*'
					});
					res.end(JSON.stringify(result));

				} catch (error) {
					console.error('Error processing request:', error);
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({
						error: error instanceof Error ? error.message : 'Internal server error'
					}));
				}
			});

		} catch (error) {
			console.error('Error handling request:', error);
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({
				error: 'Internal server error'
			}));
		}
	});

	server.listen(port, () => {
		console.log(`Trigger service listening on port ${port}`);
	});
}

if (!process.env.PROCESS_JOB) {
	console.log("Skipping Redis connection because PROCESS_JOB is not set")
	redisClient.on('error', (err: any) => console.error(err));
	redisClient.on('ready', () => console.info(`[APP] Connected to Redis`));
	redisClient.connect();

	checkAndCreateDatabaseTables()

	startServer()
}

async function getDbConnection() {
	try {
		return await pool.connect()
	} catch (error) {
		console.error(`Error getting database connection:`, error)
		throw error
	}
}

interface AWSRepository {
	name: string
	regions: string[]
	branch: string
	valueFile: {
		source: string
		bucket?: string
		fileName?: string
		presign?: boolean
	}
	argoApplicationFile?: {
		source: string
		bucket?: string
		fileName?: string
	}
}

const syncLogsToGravityViaWebsocket = async (runId: string, action: string, serviceName: string, message: string, isError: boolean = false) => {
	if (socket && socket.connected) {
		socket.emit('log', { runId, serviceName, action, message, gravityApiKey: process.env.GRAVITY_API_KEY, timestamp: new Date().toISOString(), isError })
	}
}

let socket: Socket | null = null

if (process.env.GRAVITY_API_KEY) {
	socket = io(`${process.env.GRAVITY_WEBSOCKET_URL}?isAgent=${process.env.PROCESS_JOB}`, {
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

const getGravityConfigFileFromRepo = async (
	owner: string,
	repo: string,
	branch: string,
	githubToken: string,
	servicePath: string = '.'
): Promise<any> => {
	const octokit = new Octokit({ auth: githubToken })
	const gravityPath = servicePath === '.' ? 'gravity.yaml' : `${servicePath}/gravity.yaml`

	try {
		const { data } = await octokit.repos.getContent({
			owner,
			repo,
			path: gravityPath,
			ref: branch
		})

		if ('content' in data) {
			const content = Buffer.from(data.content, 'base64').toString()
			return yaml.parse(content)
		}
		throw new Error('gravity.yaml not found')
	} catch (error) {
		console.error(`Error fetching gravity.yaml from ${gravityPath}:`, error)
		throw error
	}
}

const findServicesWithChanges = async (
	octokit: Octokit,
	owner: string,
	repo: string,
	branch: string,
	lastCommitSha: string
): Promise<ServiceChange[]> => {
	console.log(`Finding changes between ${lastCommitSha} and ${branch}`)

	// Get all gravity.yaml files in the repo
	const { data: tree } = await octokit.git.getTree({
		owner,
		repo,
		tree_sha: branch,
		recursive: '1'
	})

	// Find all directories containing gravity.yaml files
	const gravityFiles = tree.tree
		.filter(item => item?.path?.endsWith('gravity.yaml'))
		.map(item => path.dirname(item?.path ?? ''))

	// Add root directory if it has a gravity.yaml and not already in the list
	if (tree.tree.find(item => item?.path === 'gravity.yaml') && !gravityFiles.includes('.')) {
		gravityFiles.push('.')
	}

	console.log('Found gravity.yaml files in directories:', gravityFiles)

	// Get changed files since last deployment
	const { data: comparison } = await octokit.repos.compareCommits({
		owner,
		repo,
		base: lastCommitSha,
		head: branch
	})

	// If the commits are identical or the base is ahead, we should redeploy everything
	const shouldRedeployAll = comparison.status === 'identical' || comparison.status === 'behind'

	const changedFiles = shouldRedeployAll ? ['*'] : (comparison.files?.map(file => file.filename) || [])
	console.log('Changed files:', changedFiles)

	const serviceChanges: ServiceChange[] = []

	// Check each service directory for changes
	for (const servicePath of gravityFiles) {
		console.log(`Checking service path: ${servicePath}`)

		// If we should redeploy all, mark everything as changed
		const hasChanges = shouldRedeployAll || changedFiles.some(file => {
			const isChange = servicePath === '.' ?
				true : // For root directory, any change counts
				file.startsWith(`${servicePath}/`) // For subdirectories
			console.log(`File ${file} matches ${servicePath}? ${isChange}`)
			return isChange
		})

		console.log(`Service ${servicePath} has changes: ${hasChanges}`)

		if (hasChanges) {
			try {
				const gravityConfig = await getGravityConfigFileFromRepo(
					owner,
					repo,
					branch,
					process.env.GITHUB_TOKEN!!,
					servicePath
				)

				serviceChanges.push({
					servicePath,
					hasChanges: true,
					gravityConfig,
					lastCommitSha
				})
				console.log(`Added ${servicePath} to service changes`)
			} catch (error) {
				console.error(`Error fetching gravity config for ${servicePath}:`, error)
			}
		}
	}

	console.log('Final service changes:', serviceChanges)
	return serviceChanges
}

const sendSlackNotification = async (title: string, message: string) => {
	if (!process.env.SLACK_WEBHOOK_URL) {
		console.log("Slack webhook URL not found, skipping notification")
		return
	}
	try {
		const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL
		await axios.post(slackWebhookUrl, { text: `*${title}*\n${message}` })
	} catch (error) {
		console.error(`Error sending Slack notification:`)
	}
}

const syncArgoCD = async (deploymentRunId: string, serviceName: string, branch: string, argoCDUrl: string, token: string) => {
	const url = `${argoCDUrl}/api/v1/applications/${serviceName}-${branch}?refresh=hard`
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
		syncLogsToGravityViaWebsocket(deploymentRunId, "SYNC_ARGOCD", serviceName, `Sync Completed for ${serviceName} in ${branch}`)
	} catch (error) {
		console.error('Failed to trigger sync:', error)
		syncLogsToGravityViaWebsocket(deploymentRunId, "SYNC_ARGOCD", serviceName, `Sync Failed for ${serviceName} in ${branch}: ${error.message}`, true)
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

const customExec = (runId: string, action: string, serviceName: string, command: string, skipLogging: boolean = false, env: Record<string, string> = {}): Promise<string> => {
	return new Promise((resolve, reject) => {

		const cleanedCommand = command.replace(/(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|DOCKER_USERNAME)=[^\s]*/g, "$1=****").replace(/x-access-token:[^@]*@/g, "x-access-token:****@")
		console.log(`Executing command: ${cleanedCommand}`)

		const processEnv = { ...process.env, ...env };

		const processCMD = spawn(command, [], {
			shell: true,
			env: processEnv
		})

		let output = ''

		const handleOutput = (data: Buffer) => {
			const chunk = data.toString().trim()
			output += chunk + '\n'
			console.log(chunk)
			if (!skipLogging) {
				if (chunk) {
					syncLogsToGravityViaWebsocket(runId, action, serviceName, JSON.stringify(chunk), false)
				}
			}
		}

		processCMD.stdout.on('data', (data) => handleOutput(data))
		processCMD.stderr.on('data', (data) => handleOutput(data))

		processCMD.on('error', (error) => {
			console.error(error)
			syncLogsToGravityViaWebsocket(runId, action, serviceName, JSON.stringify(error.message), true)
			reject(error)
		})

		processCMD.on('close', (code) => {
			console.log(`Process exited with code: ${code}`)
			if (code !== 0) {
				const error = new Error(`Process exited with code: ${code}`)
				console.error(error)
				syncLogsToGravityViaWebsocket(runId, action, serviceName, JSON.stringify(error.message), true)
				reject(error)
			} else {
				resolve(output)
			}
		})
	})
}

const sendDetailsToAgentJob = async (details: any) => {
	const NAMESPACE = process.env.NAMESPACE || "gravity-cloud"
	const random4Char = Math.random().toString(36).substring(2, 6)

	const predefinedSecrets = `
        - name: POSTGRES_PASSWORD
          valueFrom:
                secretKeyRef:
                  name: postgres-secrets
                  key: postgres-password
        - name: REDIS_PASSWORD
          valueFrom:
                secretKeyRef:
                  name: redis-secrets
                  key: redis-password
        - name: GRAVITY_API_KEY
          valueFrom:
                secretKeyRef:
                  name: gravity-agent-secrets
                  key: gravity-api-key
        - name: GITHUB_TOKEN
          valueFrom:
                secretKeyRef:
                  name: gravity-agent-secrets
                  key: github-token
        - name: ARGOCD_TOKEN
          valueFrom:
                secretKeyRef:
                  name: gravity-agent-secrets
                  key: argo-cd-token
        - name: AWS_ACCESS_KEY_ID
          valueFrom:
                secretKeyRef:
                  name: gravity-agent-secrets
                  key: aws-access-key-id
        - name: AWS_SECRET_ACCESS_KEY
          valueFrom:
                secretKeyRef:
                  name: gravity-agent-secrets
                  key: aws-secret-access-key`

	let additionalEnvVarsFromString: { name: string, value: string }[] = []
	if (process.env.ADDITIONAL_ENV) {
		additionalEnvVarsFromString = process.env.ADDITIONAL_ENV.split(',')
			.map(pair => {
				const [name, value] = pair.split('=')
				return { name, value }
			})
			.filter(env => env.name && env.value)
	}

	const secretEnvsYaml = process.env.CUSTOM_SECRETS ?
		Object.entries(yaml.parse(process.env.CUSTOM_SECRETS)).map(([name, value]: [string, any]) => ({
			name,
			valueFrom: value.valueFrom
		})).map(secret =>
			`\n            - name: ${secret.name}
              valueFrom:
                secretKeyRef:
                  name: ${secret.valueFrom.secretKeyRef.name}
                  key: ${secret.valueFrom.secretKeyRef.key}`
		).join('') : '';

	const jobTemplate = `apiVersion: batch/v1
kind: Job
metadata:
  name: gravity-job-agent-${details.deploymentRunId}-${random4Char}
  namespace: ${NAMESPACE}
spec:
  template:
    metadata:
      labels:
        app: gravity-job-agent
    spec:
      restartPolicy: OnFailure
      serviceAccountName: gravity-job-agent-sa
      containers:
        - name: gravity-job-agent-${details.deploymentRunId}-${random4Char}
          image: gravitycloud/gravity-ci-cd-agent:${process.env.ENV === "production" ? "latest" : "dev"}
          imagePullPolicy: Always
          securityContext:
            privileged: true
            capabilities:
              add:
                - SYS_ADMIN
          volumeMounts:
            - name: cgroup
              mountPath: /sys/fs/cgroup
              readOnly: true
          env:${predefinedSecrets}${secretEnvsYaml}
            - name: GRAVITY_WEBSOCKET_URL
              value: "${process.env.GRAVITY_WEBSOCKET_URL}"
            - name: GRAVITY_API_URL
              value: "${process.env.GRAVITY_API_URL}"
            - name: PROCESS_JOB
              value: "true"
            - name: ENV
              value: "${process.env.ENV}"
            - name: GITHUB_REPOSITORIES
              value: "${process.env.GITHUB_REPOSITORIES}"
            - name: GIT_BRANCHES_ALLOWED
              value: "${process.env.GIT_BRANCHES_ALLOWED}"
            - name: GITHUB_JOB_NAME
              value: "${process.env.GITHUB_JOB_NAME}"
            - name: AWS_ACCOUNT_ID
              value: "${process.env.AWS_ACCOUNT_ID}"
            - name: POSTGRES_HOST
              value: "${process.env.POSTGRES_HOST}"
            - name: POSTGRES_USER
              value: "${process.env.POSTGRES_USER}"
            - name: POSTGRES_DB
              value: "${process.env.POSTGRES_DB}"
            - name: POSTGRES_PORT
              value: "${process.env.POSTGRES_PORT}"
            - name: REDIS_HOST
              value: "${process.env.REDIS_HOST}"
            - name: REDIS_PORT
              value: "${process.env.REDIS_PORT}"
            - name: SLACK_WEBHOOK_URL
              value: "${process.env.SLACK_WEBHOOK_URL}"
            - name: ARGOCD_URL
              value: "${process.env.ARGOCD_URL}"
            - name: DOCKER_REGISTRY_URL
              value: "${process.env.DOCKER_REGISTRY_URL}"
            - name: DOCKER_REGISTRY_PORT
              value: "${process.env.DOCKER_REGISTRY_PORT}"  			  		
            - name: DEPLOYMENT_RUN_ID
              value: "${details.deploymentRunId}"${additionalEnvVarsFromString.map(env => `
            - name: ${env.name}
              value: "${env.value}"`).join('')}
          resources:
            requests:
              memory: "512Mi"
              cpu: "512m"
            limits:
              memory: "4096Mi"
              cpu: "4000m"
      volumes:
        - name: cgroup
          hostPath:
            path: /sys/fs/cgroup
            type: Directory`

	console.log("Generated Template: ", jobTemplate)

	const tempFile = path.join(os.tmpdir(), `job-${details.deploymentRunId}-${random4Char}.yaml`)
	fs.writeFileSync(tempFile, jobTemplate)

	try {
		await customExec("", "CREATE_JOB", "", `kubectl apply -f ${tempFile}`, true)
	} finally {
		fs.unlinkSync(tempFile)
	}

	try {

		const streamKey = 'agent-job-stream'
		const consumerGroup = 'agent-job-processors'
		try {
			await redisClient.xGroupCreate(streamKey, consumerGroup, '0', {
				MKSTREAM: true
			})
		} catch (err: any) {
			if (!err.message.includes('BUSYGROUP')) {
				throw err
			}
		}

		await redisClient.xAdd(streamKey, '*', {
			'data': Buffer.from(JSON.stringify(details)).toString('base64'),
			'runId': details.deploymentRunId
		})

		console.log(`[APP] Published message to Redis stream for runId: ${details.deploymentRunId}`)
		if (process.env.ENV !== "production") {
			process.env.DEPLOYMENT_RUN_ID = details.deploymentRunId
		}
	} catch (error) {
		console.error('Error publishing to Redis stream:', error)
		throw error
	}
}

const processBranchDeletions = async (branches: any) => {
	const client = await getDbConnection()
	try {
		const branchesWithHelmDeployments = await client?.query(`
			SELECT * FROM helm_deployments 
			WHERE branch IN (SELECT DISTINCT branch FROM helm_deployments)
		`)

		// check if the branches are deleted, if so delete the helm deployments from the table
		for (const elem of branchesWithHelmDeployments?.rows) {
			if (!branches.find((b: any) => b.name === elem.branch)) {
				await Promise.all(elem.charts.split(",").map(async (chart: string) => {
					try {
						console.log(`Uninstalling Helm Chart ${chart}from namespace ${elem.branch}`)
						await customExec("", "DELETE_HELM_DEPLOYMENTS", "", `helm uninstall ${chart} -n ${elem.branch}`, true)
					} catch (error) {
						console.error(`Error uninstalling Helm Chart ${chart} from namespace ${elem.branch}:`, error)
					}

					sendSlackNotification("Helm Deployment Deleted", `Helm Deployment ${chart} deleted for ${elem.branch}`)
				}))

				await client?.query("DELETE FROM helm_deployments WHERE branch = $1", [elem.branch])
			}
		}

		const argoBranchesWithDeployments = await client?.query(`
			SELECT * FROM argo_deployments 
			WHERE branch IN (SELECT DISTINCT branch FROM argo_deployments)
		`)

		for (const elem of argoBranchesWithDeployments?.rows) {
			if (!branches.find((b: any) => b.name === elem.branch)) {
				const argoDeployments = await client?.query("SELECT * FROM argo_deployments WHERE branch = $1", [elem.branch])
				await Promise.all(argoDeployments?.rows?.map(async (argoDeployment: any) => {
					try {
						const argoFileYamlFileAsString = argoDeployment.valuesfile

						const localFilePath = path.join(os.tmpdir(), `${argoDeployment.servicename}-${elem.branch}.yaml`)
						fs.writeFileSync(localFilePath, argoFileYamlFileAsString)

						await customExec("", "DELETE_ARGO_DEPLOYMENT", argoDeployment.servicename, `kubectl delete -f ${localFilePath}`, true)
						await client?.query("DELETE FROM argo_deployments WHERE branch = $1 AND servicename = $2", [elem.branch, argoDeployment.servicename])
						fs.unlinkSync(localFilePath)

						sendSlackNotification("Argo Deployment Deleted", `Argo Deployment ${argoDeployment.servicename} deleted for ${elem.branch}`)
					} catch (error) {
						console.error(`Error deleting Argo Deployment ${argoDeployment.servicename} for ${elem.branch}:`, error)
					}
				}))
			}
		}

		const cleanupBranchesWithDeployments = await client?.query(`
			SELECT * FROM cleanup_deployments 
			WHERE branch IN (SELECT DISTINCT branch FROM cleanup_deployments)
		`)

		for (const elem of cleanupBranchesWithDeployments?.rows) {

			if (!branches.find((b: any) => b.name === elem.branch)) {
				await client?.query("DELETE FROM cleanup_deployments WHERE branch = $1", [elem.branch])

				const metadata: CleanupMetadata = JSON.parse(elem.metadata);
				const postDeployOut: string = elem.post_deploy_out
				const tempDir = path.join(os.tmpdir(), `cleanup-${v4()}`);

				try {
					// Clone repository to temporary directory
					const cloneUrl = `https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/${metadata.repository}.git`;
					await customExec("", "CLEANUP_CLONE", "", `git clone ${cloneUrl} ${tempDir}`);

					// Run cleanup command in correct service context
					// const contextPath = path.join(tempDir, metadata.servicePath);

					await customExec("", "CLEANUP_COMMAND", "", `cd ${tempDir} && ${metadata.command}`, false, {
						POST_DEPLOY_OUTPUT: postDeployOut?.trim()
					});

				} finally {
					// Cleanup temporary directory
					if (fs.existsSync(tempDir)) {
						fs.rmSync(tempDir, { recursive: true, force: true });
					}
				}
			}
		}


	} catch (error) {
		console.error(`Error processing branch deletions:`, error)
	} finally {
		client?.release()
	}
	return true
}

const syncMetaDataWithGravity = async (repository: string, branches: any) => {
	const client = await getDbConnection()
	try {
		const argoApps = await client?.query("SELECT * FROM argo_deployments")
		const helmDeployments = await client?.query("SELECT * FROM helm_deployments")
		const syncResponse = await axios.post(`${process.env.GRAVITY_API_URL}/api/v1/graviton/kube/sync-metadata`, {
			awsAccountId: process.env.AWS_ACCOUNT_ID,
			gravityApiKey: process.env.GRAVITY_API_KEY,
			branches: branches,
			repository: repository,
			argoApps: argoApps?.rows,
			helmDeployments: helmDeployments?.rows
		})
	} catch (error) {
		console.error(`Error syncing metadata with Gravity:`, error)
	} finally {
		client?.release()
	}
}

export const triggerDeployment = async (repository: string, branch: string) => {
	let client: pg.PoolClient | null = null;
	try {
		client = await getDbConnection();

		const githubToken = process.env.GITHUB_TOKEN!!

		const octokit = new Octokit({ auth: githubToken });
		const [owner, repo] = repository.split('/');

		// Get the latest commit for the branch
		const { data: branchData } = await octokit.repos.getBranch({
			owner,
			repo,
			branch
		});

		// Get all gravity.yaml files in the repo
		const { data: tree } = await octokit.git.getTree({
			owner,
			repo,
			tree_sha: branch,
			recursive: '1'
		});

		// Find all directories containing gravity.yaml files
		const gravityFiles = tree.tree
			.filter(item => item?.path?.endsWith('gravity.yaml'))
			.map(item => path.dirname(item?.path ?? ''));

		// Add root directory if it has a gravity.yaml and not already in the list
		if (tree.tree.find(item => item?.path === 'gravity.yaml') && !gravityFiles.includes('.')) {
			gravityFiles.push('.');
		}

		// Force all services to be marked as changed
		const services: ServiceChange[] = [];
		for (const servicePath of gravityFiles) {
			try {
				const gravityConfig = await getGravityConfigFileFromRepo(
					owner,
					repo,
					branch,
					githubToken,
					servicePath
				);

				services.push({
					servicePath,
					hasChanges: true, // Force all services to be marked as changed
					gravityConfig,
					lastCommitSha: branchData.commit.sha
				});
			} catch (error) {
				console.error(`Error fetching gravity config for ${servicePath}:`, error);
			}
		}

		// get the latest action 

		if (services.length === 0) {
			throw new Error("No services with gravity.yaml found in repository");
		}

		const githubActionsStatus = await axios.get(`https://api.github.com/repos/${repository}/actions/runs`, {
			headers: {
				"Authorization": `Bearer ${githubToken}`
			}
		})

		const latestDeployRun = githubActionsStatus.data.workflow_runs
			.filter((run: DeployRun) =>
				run.name === (process.env.GITHUB_JOB_NAME || "Deploy") &&
				run.status === "completed" &&
				run.head_branch === branch
			)
			.sort((a: DeployRun, b: DeployRun) =>
				new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
			)[0];

		console.log(`Latest deploy run: ${JSON.stringify(latestDeployRun)}`)

		// Generate deployment run ID
		const newDeploymentRunId = v4();

		// Send to agent job
		await sendDetailsToAgentJob({
			deploymentRunId: newDeploymentRunId,
			services,
			repository,
			latestDeployRun
		});

		return {
			deploymentRunId: newDeploymentRunId,
			services: services.map(s => s.servicePath)
		};
	} catch (error) {
		console.error(`Error triggering deployment:`, error);
		throw error;
	} finally {
		client?.release();
	}
};

const getAllBranches = async (octokit: Octokit, owner: string, repo: string): Promise<any[]> => {
	let allBranches: any[] = [];
	let page = 1;

	while (true) {
		const { data: branches } = await octokit.rest.repos.listBranches({
			owner,
			repo,
			per_page: 100,
			page
		});

		if (branches.length === 0) break;

		allBranches = allBranches.concat(branches);
		page++;
	}

	return allBranches;
}

const syncGitRepo = async () => {
	let client: pg.PoolClient | null = null
	try {
		client = await getDbConnection()
		const githubToken = process.env.GITHUB_TOKEN!!
		const githubRepositories = process.env.GITHUB_REPOSITORIES!!
		const octokit = new Octokit({ auth: githubToken })

		for (const repository of githubRepositories.split(",")) {
			console.log(`Syncing repository: ${repository}`)
			try {
				const [owner, repo] = repository.split('/')

				// get all branches for the repository
				const branches = await getAllBranches(octokit, owner, repo);

				try {
					processBranchDeletions(branches)
					syncMetaDataWithGravity(repository, branches)
				} catch (error) {
					console.error(`Error syncing metadata with Gravity for ${repository}:`, error)
				}

				// Get latest deploy run
				let allWorkflowRuns: any = []
				let page = 1

				while (true) {
					const response = await axios.get(`https://api.github.com/repos/${repository}/actions/runs`, {
						headers: {
							"Authorization": `Bearer ${githubToken}`
						},
						params: {
							per_page: 100,
							page: page
						}
					})

					const runs = response.data.workflow_runs
					if (runs.length === 0) break

					allWorkflowRuns = allWorkflowRuns.concat(runs)
					page++
				}

				const completedRuns = allWorkflowRuns
					.filter((run: DeployRun) => run.name === (process.env.GITHUB_JOB_NAME || "Deploy") && run.status === "completed")
					.reduce((acc: { [key: string]: DeployRun }, run: DeployRun) => {
						const branch = run.head_branch;
						if (!acc[branch] || new Date(run.updated_at) > new Date(acc[branch].updated_at)) {
							acc[branch] = run;
						}
						return acc;
					}, {});

				for (const [branch, latestDeployRun] of Object.entries(completedRuns) as [string, DeployRun][]) {
					console.log(`Processing latest deploy run for branch ${branch}: ${latestDeployRun.id}`);

					const gitBranchesAllowed = process.env.GIT_BRANCHES_ALLOWED!!.split(",")
					const branchMatches = gitBranchesAllowed.some(allowedBranch => {
						if (allowedBranch.endsWith('.*')) {
							const prefix = allowedBranch.slice(0, -2).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
							const pattern = new RegExp(`^${prefix}.*$`)
							return pattern.test(branch)
						}
						return allowedBranch === branch
					})

					if (!branchMatches) {
						console.log(`Branch ${branch} not in allowed list, skipping`)
						continue;
					} else {

						// check if the branch even exists in the repo
						if (!branches.find((b: any) => b.name === branch)) {
							console.log(`Branch ${branch} does not exist in the repo, skipping`)
							continue
						}

						// check if the latestDeployRun was within 30 minutes
						if (new Date(latestDeployRun.updated_at).getTime() > Date.now() - 30 * 60 * 1000) {
							console.log(`Branch ${branch} matches, processing`)
						} else {
							console.log(`Branch ${branch} matches, but not within 30 minutes, skipping`)
							continue
						}
					}

					// Check if already processed. Any state is fine, COMPLETED, FAILED, IN_PROGRESS. We do not auto-run the failed runs.
					const checkIfProcessed = await client?.query(
						"SELECT * FROM deployments WHERE actionId = $1 ORDER BY created_at DESC LIMIT 1",
						[latestDeployRun.id]
					)

					console.log(`Check if processed: ${checkIfProcessed?.rows?.length}`)

					if (checkIfProcessed?.rows?.length > 0) {
						if (checkIfProcessed?.rows[0]?.status === "FAILED_RETRY") {
							console.log("Run processed with Failed Retry. Attempting to re-run the agent job.")
							// update the status to Failed
							await client?.query(
								"UPDATE deployments SET status = 'FAILED' WHERE actionId = $1",
								[latestDeployRun.id]
							)
						} else {
							if (latestDeployRun?.run_attempt > 1 && checkIfProcessed?.rows[0]?.status !== "FAILED") {
								console.log("Run already processed, skipping.")
								return
							}

							if (checkIfProcessed?.rows[0]?.status === "IN_PROGRESS") {
								console.log("Current run is already in progress, skipping.")
							} else {
								console.log(`Run already processed with status ${checkIfProcessed?.rows[0]?.status}, skipping.`)
								if (checkIfProcessed?.rows[0]?.status === "FAILED") {
									console.log("To re-run the agent job, trigger the workflow manually.")
								}
							}
							return
						}
					}

					// Find services with changes
					const services = await findServicesWithChanges(
						octokit,
						owner,
						repo,
						latestDeployRun.head_branch,
						latestDeployRun.head_sha
					)

					console.log(`Services with changes: ${services.length}`)

					if (services.length === 0) {
						console.log(`No services with changes found, skipping`)
						return
					}

					deploymentRunId = v4()

					const userDetails = {
						id: latestDeployRun?.actor?.id,
						login: latestDeployRun?.actor?.login,
						avatar_url: latestDeployRun?.actor?.avatar_url,
						html_url: latestDeployRun?.actor?.html_url,
						type: latestDeployRun?.actor?.type
					}

					const destinations = new Set<string>()
					const regionsSet = new Set<string>()

					for (const service of services) {
						if (service.gravityConfig?.spec?.aws) {
							destinations.add("AWS")
							await Promise.all(service.gravityConfig?.spec?.aws?.repository?.map(async (repoDetails: AWSRepository) => {
								const awsRepositoryRegions = repoDetails?.regions
								awsRepositoryRegions.forEach((region) => regionsSet.add(region))
							}))
						}
					}

					await client?.query(
						`INSERT INTO deployments (runId, actionId, commit_id, repository_name, branch, service_path, commit_sha, status, destinations, regions, user_id, user_details) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
						[
							deploymentRunId,
							latestDeployRun.id,
							latestDeployRun.head_commit.id,
							repository,
							latestDeployRun.head_branch,
							services?.map((service) => service.servicePath).join(','),
							latestDeployRun.head_sha,
							"IN_PROGRESS",
							Array.from(destinations).join(','),
							Array.from(regionsSet).join(','),
							latestDeployRun.actor.id,
							JSON.stringify(userDetails)
						]
					)

					syncLogsToGravityViaWebsocket(deploymentRunId, "PIPELINE_CREATED", "COMMON_ACTION", JSON.stringify({ deploymentRunId, actionId: latestDeployRun.id, commitId: latestDeployRun?.head_commit?.id, repository, branch: latestDeployRun?.head_branch, userDetails: JSON.stringify(userDetails), servicePaths: services?.map((service) => service.servicePath), destinations: Array.from(destinations), regions: Array.from(regionsSet) }))

					// send the details to the agent job
					await sendDetailsToAgentJob({ deploymentRunId, services, repository, latestDeployRun })
				}
			} catch (error) {
				console.error(`Error processing repository ${repository}:`, error)
				sendSlackNotification("Deployment Failed", `Error processing repository ${repository}: ${error}`)
			}
		}

		return true
	} catch (error) {
		console.error(`Error in syncGitRepo:`, error)
		sendSlackNotification("Deployment Failed", `Error in syncGitRepo: ${error}`)
	} finally {
		client?.release()
		return false
	}
}

if (!process.env.PROCESS_JOB) {
	setInterval(syncGitRepo, 30000)
}
if (process.env.ENV === "development") {
	redisClient.on('error', (err: any) => console.error(err));
	redisClient.on('ready', () => console.info(`[APP] Connected to Redis`));
	redisClient.connect();
	checkAndCreateDatabaseTables()
	setInterval(syncGitRepo, 30000)
	// syncGitRepo()
	startServer()
}

// ##########################################################
// Below is the agent job code that runs the CI/CD pipeline, this gets deployed with PROCESS_JOB ENV to indicate that the agent job should be run

let deploymentRunId: any
let services: any
let repository: any
let latestDeployRun: any

const processJob = async () => {

	if (deploymentRunId) {

		let client: pg.PoolClient | null = null
		try {
			const githubToken = process.env.GITHUB_TOKEN!!

			const octokit = new Octokit({ auth: githubToken })

			client = await getDbConnection()

			const [owner, repo] = repository.split('/')

			const lastRunBranch = latestDeployRun.head_branch

			await Promise.all(services.map(async (service: any) => {
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
					await customExec(deploymentRunId, "GIT_CLONE", serviceName, `git clone --branch ${lastRunBranch} ${cloneUrl} ${gitRepoPath}`)


					if (service.gravityConfig?.spec?.preDeploy) {
						await Promise.all(service.gravityConfig?.spec?.preDeploy?.map(async (preDeployStep: PreDeploy) => {

							if (preDeployStep.once) {
								const hasRunDeploy = await client?.query("SELECT COUNT(*) FROM deployments WHERE branch = $1", [lastRunBranch])
								if (hasRunDeploy && hasRunDeploy.rows[0].count > 0) {
									// skip any further processing
									return
								}
							}

							// check if branches array is null, then always run the command
							let runCommand = true
							if (preDeployStep.branches && preDeployStep.branches.length > 0) {
								runCommand = preDeployStep.branches.includes(lastRunBranch)

								// also check if the branch is a wildcard pattern
								if (preDeployStep.branches.some(branch => branch.includes('.*'))) {
									const branch = preDeployStep.branches.find((branch: string) => branch.includes('.*'))
									const prefix = branch?.slice(0, -2).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
									const pattern = new RegExp(`^${prefix}.*$`)
									runCommand = pattern.test(lastRunBranch)
								}
							}

							if (runCommand) {
								await customExec(deploymentRunId, "PRE_DEPLOY_STEP", serviceName, `cd ${gitRepoPath} && ${preDeployStep?.command}`)
								sendSlackNotification("Running Pre Deploy Command", `${preDeployStep.command} for ${serviceName} / ${lastRunBranch} in ${repository}`)
							}
						}))
					}

					if (service.gravityConfig?.spec?.actions) {
						await Promise.all(service.gravityConfig?.spec?.actions?.map(async (action: Action) => {
							try {

								const arch = await customExec(deploymentRunId, "SETUP_ACTION", serviceName, "uname -m")
								const installArch = arch.trim() === 'x86_64' ? 'amd64' :
									arch.trim() === 'aarch64' ? 'arm64' :
										arch.trim() === 'armv7l' ? 'armv6l' :
											'amd64' // fallback to amd64 if unknown

								switch (action.uses) {
									case 'actions/setup-go@v1':
										const goVersion = action.with.version
										syncLogsToGravityViaWebsocket(deploymentRunId, "SETUP_ACTION", serviceName, `Installing Go version ${goVersion}`)



										// Download and extract Go
										await customExec(deploymentRunId, "SETUP_ACTION", serviceName, `
											curl -OL https://golang.org/dl/go${goVersion}.linux-${installArch}.tar.gz && \
											rm -rf /usr/local/go && \
											tar -C /usr/local -xzf go${goVersion}.linux-${installArch}.tar.gz && \
											rm go${goVersion}.linux-${installArch}.tar.gz && \
											ln -sf /usr/local/go/bin/go /usr/local/bin/go && \
											ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt
										`)

										await customExec(deploymentRunId, "SETUP_ACTION", serviceName, `
											mkdir -p /root/go && \
											chmod 755 /root/go
										`)

										// Add Go to global PATH and set GOPATH
										fs.writeFileSync('/etc/profile.d/go.sh', 'export PATH=$PATH:/usr/local/go/bin\nexport GOPATH=/root/go\nexport PATH=$PATH:$GOPATH/bin\n')
										fs.chmodSync('/etc/profile.d/go.sh', '755')

										// Set environment variables for current process
										process.env.PATH = `${process.env.PATH}:/usr/local/go/bin:/root/go/bin`
										process.env.GOPATH = '/root/go'
										break

									case 'cue-lang/setup-cue@v1':
										const cueVersion = action.with.version
										syncLogsToGravityViaWebsocket(deploymentRunId, "SETUP_ACTION", serviceName, `Installing Cue version ${cueVersion}`)

										await customExec(deploymentRunId, "SETUP_ACTION", serviceName, `
											curl -OL https://github.com/cue-lang/cue/releases/download/${cueVersion}/cue_${cueVersion}_linux_${installArch}.tar.gz && \
											tar -xzf cue_${cueVersion}_linux_${installArch}.tar.gz && \
											chmod +x cue && \
											mv cue /usr/local/bin/cue && \
											rm cue_${cueVersion}_linux_${installArch}.tar.gz
										`)

										// Add Cue to global PATH
										fs.writeFileSync('/etc/profile.d/cue.sh', 'export PATH=$PATH:/usr/local/bin\n')
										fs.chmodSync('/etc/profile.d/cue.sh', '755')

										// Set environment variables for current process
										process.env.PATH = `${process.env.PATH}:/usr/local/bin`
										break

									case 'actions/encore@v1':
										const encoreVersion = action.with.version
										syncLogsToGravityViaWebsocket(deploymentRunId, "SETUP_ACTION", serviceName, `Installing Encore version ${encoreVersion}`)
										await customExec(deploymentRunId, "SETUP_ACTION", serviceName, `
											curl -L https://encore.dev/install.sh | bash -s -- ${encoreVersion} && \
											mkdir -p /usr/local/bin && \
											mv ~/.encore/bin/encore /usr/local/bin/encore
										`)
										break

									default:
										console.warn(`Unknown action: ${action.uses}`)
										syncLogsToGravityViaWebsocket(deploymentRunId, "SETUP_ACTION", serviceName, `Unknown action: ${action.uses}`, true)
								}
							} catch (error) {
								console.error(`Error installing action ${action.uses}:`, error)
								syncLogsToGravityViaWebsocket(deploymentRunId, "SETUP_ACTION", serviceName, `Failed to install ${action.uses}: ${error.message}`, true)
								throw error
							}
						}))
					}

					sendSlackNotification("Docker Build Started", `Docker build started for ${serviceName} / ${lastRunBranch} in ${repository}`)

					const localRegistryUrl = `${process.env?.DOCKER_REGISTRY_URL}:${process.env?.DOCKER_REGISTRY_PORT}`

					// Build Docker image
					let dockerBuildCli = process.env.ENV === "production" ? "buildah --storage-driver vfs" : "docker"
					const serviceContext = path.join(gitRepoPath, service.servicePath)
					const dockerfilePath = path.join(serviceContext, 'Dockerfile')

					const dockerBuildCommand = process.env.ENV === "production"
						? `${dockerBuildCli} bud --isolation chroot --platform=linux/amd64 --tls-verify=false --layers --jobs=20 --cache-from ${localRegistryUrl}/${owner}/${serviceName}/cache --cache-to ${localRegistryUrl}/${owner}/${serviceName}/cache -t ${owner}/${serviceName}:latest -f ${dockerfilePath} ${serviceContext}`
						: `${dockerBuildCli} build --platform=linux/amd64 -t ${owner}/${serviceName}:latest -f ${dockerfilePath} ${serviceContext}`;

					await customExec(deploymentRunId, "DOCKER_IMAGE_BUILD", serviceName, dockerBuildCommand)

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
											await customExec(deploymentRunId, "ECR_REPOSITORY_CHECK", serviceName, `AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID} AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY} aws ecr describe-repositories --repository-names ${awsRepositoryName} --region ${region}`)
										} catch (error) {
											console.error(`Error checking if repository ${awsRepositoryName} exists: ${error}`)
											console.log("Creating repository...")
											await customExec(deploymentRunId, "ECR_REPOSITORY_CREATE", serviceName, `AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID} AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY} aws ecr create-repository --repository-name ${awsRepositoryName} --region ${region}`)
										}

										const imageTag = `${latestDeployRun.head_sha?.slice(0, 7)}-${lastRunBranch}`

										// tag the docker image with the aws repository name and region
										const dockerTagCommand = `${dockerBuildCli} tag ${owner}/${serviceName}:latest ${ecrBaseURL}/${awsRepositoryName}:${imageTag}`
										await customExec(deploymentRunId, "DOCKER_IMAGE_TAG", serviceName, dockerTagCommand)

										const dockerPushCommand = `AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID} AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY} aws ecr get-login-password --region ${region} | ${dockerBuildCli} login --username AWS --password-stdin ${ecrBaseURL} && ${dockerBuildCli} push ${ecrBaseURL}/${awsRepositoryName}:${imageTag}`
										await customExec(deploymentRunId, "DOCKER_IMAGE_PUSH", serviceName, dockerPushCommand)

										// await customExec(deploymentRunId, "DOCKER_LOGOUT", serviceName, `${dockerBuildCli} logout ${ecrBaseURL}`)

										sendSlackNotification("Docker Push Completed", `Docker push completed for ${serviceName} / ${lastRunBranch} in ${repository} at ${region}}`)

										let newLocalValuesFilePath: string | null = null

										let preSignedS3Url = null

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

												newLocalValuesFilePath = path.join(tempDir, valueFileName)
												fs.writeFileSync(newLocalValuesFilePath, yaml.stringify(parsedValuesFile))

												console.log(`Updated ${valueFileName} for ${lastRunBranch} in ${region}`)
												sendSlackNotification("Values File Updated", `Updated ${valueFileName} for ${serviceName} / ${lastRunBranch} in ${repository} at ${region}`)

												newValuesFiles.push(JSON.stringify({ name: valueFileName, previousContent: valuesFileContent, newContent: yaml.stringify(parsedValuesFile) }))
											} catch (error) {
												console.error(`Error updating ${valueFileName}: ${error}`)
												await client?.query("UPDATE deployments SET status = $1 WHERE runId = $2", ["FAILED", deploymentRunId])
												syncLogsToGravityViaWebsocket(deploymentRunId, "PIPELINE_FAILED", serviceName, JSON.stringify({ error: error.message }), true)
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

												let latestValueFileFromS3Bucket = ""

												let fileName = repoDetails?.valueFile?.fileName
												if (fileName) {
													// List all objects in the bucket with the given prefix
													const listCommand = `AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID} AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY} aws s3api list-objects-v2 --bucket ${s3BucketName} ${s3Prefix ? `--prefix "${s3Prefix}/" --delimiter "/"` : '--delimiter "/"'} --output json`
													const listResult = await customExec(deploymentRunId, "UPDATING_VALUES_FILE", serviceName, listCommand, true)
													const objects = JSON.parse(listResult).Contents

													// Filter objects that contain the fileName pattern
													const matchingFiles = objects
														.map((obj: any) => obj.Key)
														.filter((key: string) => key.includes(fileName))
														.sort((a: string, b: string) => b.localeCompare(a))

													if (matchingFiles.length > 0) {
														latestValueFileFromS3Bucket = matchingFiles[0].trim()
													} else {
														console.error(`No files found matching pattern ${fileName} in ${s3BucketName}/${s3Prefix || ''}`)
														return
													}
												} else {
													latestValueFileFromS3Bucket = await customExec(deploymentRunId, "UPDATING_VALUES_FILE", serviceName, `AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID} AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY} aws s3api list-objects-v2 --bucket ${s3BucketName} ${s3Prefix ? `--prefix "${s3Prefix}/" --delimiter "/"` : ''}  --query 'sort_by(Contents, &LastModified)[-1].Key' --output text`, true)
												}

												if (!latestValueFileFromS3Bucket) {
													console.error(`No value file found in ${valueFilesPath}`)
													return
												}

												latestValueFileFromS3Bucket = latestValueFileFromS3Bucket.trim()

												const tempDir = os.tmpdir()
												const localFilePath = path.join(tempDir, path.basename(latestValueFileFromS3Bucket))

												await customExec(deploymentRunId, "UPDATING_VALUES_FILE", serviceName, `AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID} AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY} aws s3 cp s3://${s3BucketName}/${s3Prefix ? `${s3Prefix}/` : ''}${path.basename(latestValueFileFromS3Bucket)} ${localFilePath}`, true)

												const valuesFileContent = fs.readFileSync(localFilePath, 'utf8')

												if (!valuesFileContent) {
													console.error(`Error getting values file content from ${valueFilesPath}`)
													return
												}

												const parsedValuesFile = yaml.parse(valuesFileContent);
												if (!updateImageTag(parsedValuesFile, imageTag)) {
													console.error('Error: No image.tag pattern found in values file');
													return
												}

												// create a temporary file with the new values file content with same name as the original one
												fs.writeFileSync(localFilePath, yaml.stringify(parsedValuesFile))

												newLocalValuesFilePath = localFilePath

												// upload the temporary file to the s3 bucket
												try {
													console.log(`Updating S3 file: ${s3BucketName}/${s3Prefix ? `${s3Prefix}/` : ''}${latestValueFileFromS3Bucket}`)

													// First, delete the existing file
													console.log(`Deleting existing S3 file: ${s3BucketName}/${s3Prefix ? `${s3Prefix}/` : ''}${latestValueFileFromS3Bucket}`)

													const s3DeleteCommand = `AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID} AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY} aws s3 rm s3://${s3BucketName}/${s3Prefix ? `${s3Prefix}/` : ''}${path.basename(latestValueFileFromS3Bucket)}`
													await customExec(deploymentRunId, "DELETING_S3_FILE", serviceName, s3DeleteCommand, true)
													console.log(`Successfully deleted existing S3 file: ${s3BucketName}/${s3Prefix ? `${s3Prefix}/` : ''}${path.basename(latestValueFileFromS3Bucket)}`)

													// Then, upload the new file
													console.log(`Uploading new S3 file: ${s3BucketName}/${s3Prefix ? `${s3Prefix}/` : ''}${path.basename(latestValueFileFromS3Bucket)}`)

													const s3UploadCommand = `AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID} AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY} aws s3 cp ${localFilePath} s3://${s3BucketName}/${s3Prefix ? `${s3Prefix}/` : ''}${path.basename(latestValueFileFromS3Bucket)}`
													await customExec(deploymentRunId, "UPLOADING_S3_FILE", serviceName, s3UploadCommand, true)
													console.log(`Successfully uploaded new values file to S3 bucket: ${s3BucketName}/${s3Prefix ? `${s3Prefix}/` : ''}${path.basename(latestValueFileFromS3Bucket)}`)

													sendSlackNotification("S3 Values File Updated", `Updated ${path.basename(latestValueFileFromS3Bucket)} for ${serviceName} / ${lastRunBranch} in ${repository} at ${region}`)

													if (repoDetails?.argoApplicationFile?.source === "s3" && repoDetails?.valueFile?.presign === true) {
														// Generate pre-signed URL for the updated values file using AWS CLI

														// get the first part from the bucket name and find region for that
														const getBucketRegionCommand = `AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID} AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY} aws s3api get-bucket-location --bucket ${s3BucketName}`
														const bucketRegionResponse = await customExec(deploymentRunId, "GETTING_BUCKET_REGION", serviceName, getBucketRegionCommand, true);
														const bucketRegion = JSON.parse(bucketRegionResponse).LocationConstraint || 'us-east-1';

														const preSignedUrlCommand = `AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID} AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY} aws s3 presign s3://${s3BucketName}/${s3Prefix ? `${s3Prefix}/` : ''}${path.basename(latestValueFileFromS3Bucket)} --expires-in 86400 --region ${bucketRegion}`
														preSignedS3Url = (await customExec(deploymentRunId, "GENERATING_PRESIGNED_URL", serviceName, preSignedUrlCommand, true)).trim();
														console.log(`Generated pre-signed URL for values file: ${preSignedS3Url}`);
													}

												} catch (error) {
													console.error(`Failed to update values file in S3 bucket: ${error}`)
													await client?.query("UPDATE deployments SET status = $1 WHERE runId = $2", ["FAILED", deploymentRunId])
													syncLogsToGravityViaWebsocket(deploymentRunId, "PIPELINE_FAILED", serviceName, JSON.stringify({ error: `S3 file update failed: ${error.message}` }), true)
													sendSlackNotification("Values File Update Failed", `Error updating values file in S3 bucket for ${lastRunBranch} in ${region}: ${error}`)
													throw error
												}

												newValuesFiles.push(JSON.stringify({ name: path.basename(latestValueFileFromS3Bucket), previousContent: valuesFileContent, newContent: yaml.stringify(parsedValuesFile) }))

											} catch (error) {
												console.error(`Error updating ${repoDetails?.valueFile?.bucket}: ${error}`)
												await client?.query("UPDATE deployments SET status = $1 WHERE runId = $2", ["FAILED", deploymentRunId])
												syncLogsToGravityViaWebsocket(deploymentRunId, "PIPELINE_FAILED", serviceName, JSON.stringify({ error: error.message }), true)
												sendSlackNotification("S3 File Update Failed", `Error updating ${repoDetails?.valueFile?.bucket} for ${lastRunBranch} in ${region}: ${error}`)
											}
										}

										syncLogsToGravityViaWebsocket(deploymentRunId, "SYNC_ARGOCD", serviceName, `Syncing ArgoCD for ${serviceName} in ${repository} at ${region}`)

										if (!process.env.ARGOCD_URL) {
											console.log(`ArgoCD URL not found, skipping sync for ${serviceName} in ${lastRunBranch}`)
										} else {
											if (repoDetails?.argoApplicationFile?.source === "s3") {
												// get the file from s3
												let argoApplicationFilePath = repoDetails.argoApplicationFile?.bucket
												let s3BucketName = argoApplicationFilePath
												let s3Prefix = ''

												if (argoApplicationFilePath?.includes('/')) {
													const parts = argoApplicationFilePath.split('/')
													s3BucketName = parts[0]

													const processedParts = parts.slice(1).map((part: string) => {
														if (part.endsWith('.*')) {
															return lastRunBranch
														}
														return part
													})
													s3Prefix = processedParts.join('/')
												}


												let latestArgoApplicationFileFromS3Bucket = ""

												let fileName = repoDetails?.argoApplicationFile?.fileName
												if (fileName) {
													// List all objects in the bucket with the given prefix
													const listCommand = `AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID} AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY} aws s3api list-objects-v2 --bucket ${s3BucketName} ${s3Prefix ? `--prefix "${s3Prefix}/" --delimiter "/"` : '--delimiter "/"'} --output json`
													const listResult = await customExec(deploymentRunId, "UPDATING_VALUES_FILE", serviceName, listCommand, false)
													const objects = JSON.parse(listResult).Contents

													// Filter objects that contain the fileName pattern
													const matchingFiles = objects
														.map((obj: any) => obj.Key)
														.filter((key: string) => key.includes(fileName))
														.sort((a: string, b: string) => b.localeCompare(a))

													if (matchingFiles.length > 0) {
														latestArgoApplicationFileFromS3Bucket = matchingFiles[0].trim()
													} else {
														console.error(`No files found matching pattern ${fileName} in ${s3BucketName}/${s3Prefix || ''}`)
														return
													}
												} else {
													latestArgoApplicationFileFromS3Bucket = await customExec(deploymentRunId, "APPLYING_ARGO_APPLICATION_FILE", serviceName, `AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID} AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY} aws s3api list-objects-v2 --bucket ${s3BucketName} ${s3Prefix ? `--prefix "${s3Prefix}/" --delimiter "/"` : ''}  --query 'sort_by(Contents, &LastModified)[-1].Key' --output text`, false)
												}

												if (!latestArgoApplicationFileFromS3Bucket) {
													console.error(`No value file found in ${argoApplicationFilePath}`)
													return
												}

												latestArgoApplicationFileFromS3Bucket = latestArgoApplicationFileFromS3Bucket.trim()

												const tempDir = os.tmpdir()
												const localFilePath = path.join(tempDir, path.basename(latestArgoApplicationFileFromS3Bucket))

												await customExec(deploymentRunId, "APPLYING_ARGO_APPLICATION_FILE", serviceName, `AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID} AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY} aws s3 cp s3://${s3BucketName}/${s3Prefix ? `${s3Prefix}/` : ''}${path.basename(latestArgoApplicationFileFromS3Bucket)} ${localFilePath}`, false)

												const argoApplicationFileContent = fs.readFileSync(localFilePath, 'utf8')

												if (!argoApplicationFileContent) {
													console.error(`Error getting argo application file content from ${argoApplicationFilePath}`)
													return
												}

												fs.writeFileSync(localFilePath, argoApplicationFileContent)

												if (preSignedS3Url && repoDetails?.valueFile?.presign === true) {
													// Parse YAML content and update the values file URL
													const argoAppYaml = yaml.parse(argoApplicationFileContent)

													// Find and replace the values file URL in the Argo application spec
													if (argoAppYaml?.spec?.source?.helm?.valueFiles) {
														argoAppYaml.spec.source.helm.valueFiles = [preSignedS3Url]
													}

													// Write the updated YAML back to file
													fs.writeFileSync(localFilePath, yaml.stringify(argoAppYaml))
												}

												let kubectlApplyCommand = `kubectl apply -f ${localFilePath}`

												await customExec(deploymentRunId, "APPLYING_ARGO_APPLICATION_FILE", serviceName, kubectlApplyCommand, false)
												await client?.query("INSERT INTO argo_deployments (runId, branch, namespace, status, serviceName, valuesFile, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)", [deploymentRunId, lastRunBranch, lastRunBranch, "COMPLETED", serviceName, argoApplicationFileContent, new Date()])
												fs.unlinkSync(localFilePath)
											} else {
												await syncArgoCD(deploymentRunId, serviceName, lastRunBranch, process.env.ARGOCD_URL, process.env.ARGOCD_TOKEN!!)
											}
										}
										sendSlackNotification("ArgoCD Synced", `ArgoCD synced for ${serviceName} in ${repository} at ${region}`)

										if (newLocalValuesFilePath) {
											fs.unlinkSync(newLocalValuesFilePath)
										}

									} catch (error) {
										console.error(`Error processing region ${region}: ${error}`)
										await client?.query("UPDATE deployments SET status = $1 WHERE runId = $2", ["FAILED", deploymentRunId])
										syncLogsToGravityViaWebsocket(deploymentRunId, "PIPELINE_FAILED", serviceName, JSON.stringify({ error: error.message }), true)
										sendSlackNotification("Deployment Failed", `Error processing region ${region} for ${repository}: ${error}`)
									}
								}))
							} catch (error) {
								console.error(`Error processing AWS repository ${repoDetails.name}: ${error}`)
								console.error('Stack trace:', error.stack)
								await client?.query("UPDATE deployments SET status = $1 WHERE runId = $2", ["FAILED", deploymentRunId])
								syncLogsToGravityViaWebsocket(deploymentRunId, "PIPELINE_FAILED", serviceName, JSON.stringify({ error: error.message }), true)
								sendSlackNotification("Deployment Failed", `Error processing AWS repository ${repoDetails.name} for ${repository}: ${error}`)
							}
						}))
					}

					if (service.gravityConfig?.spec?.postDeploy) {
						await Promise.all(service.gravityConfig?.spec?.postDeploy?.map(async (postDeployStep: PostDeploy) => {

							if (postDeployStep.once) {
								const hasRunDeploy = await client?.query("SELECT COUNT(*) FROM deployments WHERE branch = $1", [lastRunBranch])
								if (hasRunDeploy && hasRunDeploy.rows[0].count > 0) {
									// skip any further processing
									return
								}
							}

							// check if branches array is null, then always run the command
							let runCommand = true
							if (postDeployStep.branches && postDeployStep.branches.length > 0) {
								runCommand = postDeployStep.branches.includes(lastRunBranch)

								// also check if the branch is a wildcard pattern
								if (postDeployStep.branches.some(branch => branch.includes('.*'))) {
									const branch = postDeployStep.branches.find((branch: string) => branch.includes('.*'))
									const prefix = branch?.slice(0, -2).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
									const pattern = new RegExp(`^${prefix}.*$`)

									runCommand = pattern.test(lastRunBranch)
								}
							}

							if (runCommand) {
								sendSlackNotification("Running Post Deploy Command", `${postDeployStep.command} for ${serviceName} / ${lastRunBranch} in ${repository}`)
								const postDeployCommandResult = await customExec(deploymentRunId, "POST_DEPLOY_STEP", serviceName, `cd ${gitRepoPath} && ${postDeployStep.command}`, false, { BRANCH: lastRunBranch, ...(postDeployStep.env?.reduce((acc, env) => ({ ...acc, [env.name]: env.value }), {}) || {}) })

								if (service.gravityConfig?.spec?.cleanup) {
									await Promise.all(service.gravityConfig?.spec?.cleanup?.map(async (cleanupStep: Cleanup) => {
										let saveInDatabase = false;

										if (cleanupStep.branches && cleanupStep.branches.length > 0) {
											saveInDatabase = cleanupStep.branches.includes(lastRunBranch);

											// also check if the branch is a wildcard pattern
											if (cleanupStep.branches.some(branch => branch.includes('.*'))) {
												const branch = cleanupStep.branches.find((branch: string) => branch.includes('.*'))
												const prefix = branch?.slice(0, -2).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
												const pattern = new RegExp(`^${prefix}.*$`)
												saveInDatabase = pattern.test(lastRunBranch)
											}
										}

										if (saveInDatabase) {
											const cleanupMetadata: CleanupMetadata = {
												command: cleanupStep.command,
												repository,
												owner,
												repo,
												branch: lastRunBranch,
												servicePath: service.servicePath
											};

											await client?.query(
												"INSERT INTO cleanup_deployments (branch, metadata, post_deploy_out) VALUES ($1, $2, $3)",
												[lastRunBranch, JSON.stringify(cleanupMetadata), postDeployCommandResult]
											);
										}
									}));
								}

							}
						}))
					}

					// Update deployment status
					await client?.query(
						"UPDATE deployments SET values_files = $1, status = $2 WHERE runId = $3",
						[JSON.stringify(newValuesFiles), "COMPLETED", deploymentRunId]
					)

					syncLogsToGravityViaWebsocket(deploymentRunId, "PIPELINE_COMPLETED", serviceName, JSON.stringify({ newValuesFiles }), false)

					// Cleanup
					if (fs.existsSync(gitRepoPath)) {
						fs.rmSync(gitRepoPath, { recursive: true, force: true })
					}
				} catch (error) {
					console.error(`Error processing service ${service.servicePath}: ${error}`)
					await client?.query("UPDATE deployments SET status = $1 WHERE runId = $2", ["FAILED", deploymentRunId])
					syncLogsToGravityViaWebsocket(deploymentRunId, "PIPELINE_FAILED", "COMMON_ACTION", JSON.stringify({ error: error.message }), true)
					sendSlackNotification("Deployment Failed", `Error processing service ${service.servicePath} for ${repository}: ${error}`)
				}
			}))

			const matchedAllowedRegex = process.env.GIT_BRANCHES_ALLOWED?.split(',').find(allowedBranch => {
				// Check for exact match first
				if (allowedBranch === lastRunBranch) {
					return allowedBranch;
				}
				// Check for wildcard pattern match
				if (allowedBranch.endsWith('.*')) {
					const prefix = allowedBranch.slice(0, -2).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
					const pattern = new RegExp(`^${prefix}.*$`);
					if (pattern.test(lastRunBranch)) {
						return allowedBranch;
					}
				}

				return false
			});

			if (matchedAllowedRegex && process.env.GRAVITY_API_URL) {
				syncLogsToGravityViaWebsocket(deploymentRunId, "CHART_DEPENDENCIES", `[pipeline] ${lastRunBranch}`, `Fetching chart dependecies for branch: ${lastRunBranch}`, false)
				const pipelineChartsRez = await axios.post<PipelineCharts>(`${process.env.GRAVITY_API_URL}/api/v1/graviton/kube/pipeline-charts`, {
					awsAccountId: process.env.AWS_ACCOUNT_ID,
					gravityApiKey: process.env.GRAVITY_API_KEY,
					branch: matchedAllowedRegex
				})

				const pipelineCharts = pipelineChartsRez?.data

				syncLogsToGravityViaWebsocket(deploymentRunId, "CHART_DEPLOYMENT", `[pipeline] ${lastRunBranch}`, `Found following charts: ${JSON.stringify(pipelineCharts?.charts?.map((chart: ChartDetails) => chart.chartName)) ?? "None"}`, false)
				if (pipelineCharts?.charts?.length > 0) {
					await Promise.all(pipelineCharts?.charts?.map(async (chart: ChartDetails) => {

						try {
							const cleanChartName = chart?.chartName?.replace('/', '_')

							const tempDir = os.tmpdir()
							const valuesFilePath = path.join(tempDir, `${cleanChartName}-values-${lastRunBranch}.yaml`)
							fs.writeFileSync(valuesFilePath, chart.valuesFile)

							// replace variables in the values file. Accepted variables: {{BRANCH_NAME}}, {{NAMESPACE}}
							const valuesFileContent = fs.readFileSync(valuesFilePath, 'utf8')
							const updatedValuesFileContent = valuesFileContent.replace(/{{BRANCH_NAME}}/g, lastRunBranch).replace(/{{NAMESPACE}}/g, lastRunBranch)
							fs.writeFileSync(valuesFilePath, updatedValuesFileContent)

							syncLogsToGravityViaWebsocket(deploymentRunId, "CHART_DEPLOYMENT", `[pipeline] ${lastRunBranch}`, `Deploying chart: ${JSON.stringify(chart)}`, false)

							//  need to add repository to via helm repo add
							const helmRepoAddCommand = `helm repo add ${chart.repositoryName} ${chart.chartRepository} --force-update`
							await customExec(deploymentRunId, "CHART_DEPLOYMENT", lastRunBranch, helmRepoAddCommand, false)

							await customExec(deploymentRunId, "CHART_DEPLOYMENT", lastRunBranch, "helm repo update", false)

							// remove branch name from chart name
							const helmChartInstallCommand = `helm upgrade --install ${cleanChartName} ${chart.chartName} --repo ${chart.chartRepository} --namespace ${lastRunBranch} --create-namespace --version ${chart.chartVersion} -f ${valuesFilePath}`
							console.log(`Helm command: ${helmChartInstallCommand}`)
							// await customExec(deploymentRunId, "CHART_DEPLOYMENT", lastRunBranch, helmChartInstallCommand, false)
							fs.unlinkSync(valuesFilePath)
						} catch (error) {
							console.error(`Error deploying chart ${chart.chartName}: ${error}`)
							syncLogsToGravityViaWebsocket(deploymentRunId, "CHART_DEPLOYMENT", `[pipeline] ${lastRunBranch}`, `Error deploying chart ${chart.chartName}: ${error}`, false)
						}

					}))

					await client?.query("INSERT INTO helm_deployments (runId, branch, namespace, status, charts, updated_at) VALUES ($1, $2, $3, $4, $5, $6)", [deploymentRunId, lastRunBranch, lastRunBranch, "COMPLETED", pipelineCharts?.charts?.map((chart: ChartDetails) => chart.chartName?.replace('/', '_')).join(","), new Date()])
				}
			}

		} catch (error) {
			console.error(`Error parsing job data: ${error}`)
			throw error
		} finally {
			client?.release()
			process.exit(0)
		}
	} else {
		console.log(`[APP] No deployment run id found. Skipping job processing`)
	}

	deploymentRunId = undefined

	process.exit(0)
}

const shutdown = () => {
	console.log('Shutting down server...');
	server?.close(() => {
		console.log('Server closed');
	});
};

const cleanup = async () => {
	if (deploymentRunId) {
		console.log(`Crash. Cleaning up for deployment run id: ${deploymentRunId}`)
		let client: pg.PoolClient | null = null
		try {
			client = await pool.connect()
			await client?.query("UPDATE deployments SET status = $1 WHERE runId = $2", ["FAILED_RETRY", deploymentRunId])
			syncLogsToGravityViaWebsocket(deploymentRunId, "PIPELINE_FAILED", "COMMON_ACTION", JSON.stringify({ error: "Pod termination" }), true)
		} finally {
			client?.release()
		}
	}

	shutdown()
	process.exit(1)
};

// Register signal handlers
['SIGTERM', 'SIGINT', 'SIGUSR2'].forEach(signal => {
	process.on(signal, async () => {
		console.log(`Received ${signal} signal`);
		await cleanup();
	});
});

// Handle uncaught exceptions
process.on('uncaughtException', async (error) => {
	console.error('Uncaught Exception:', error);
	await cleanup();
});

// Handle unhandled promise rejections
process.on('unhandledRejection', async (reason, promise) => {
	console.error('Unhandled Rejection at:', promise, 'reason:', reason);
	await cleanup();
});

// listen for messages in the redis stream
if (process.env.PROCESS_JOB) {
	const subscriberClient = redis.createClient({
		url: `redis://:${process.env.REDIS_PASSWORD}@${process.env.REDIS_HOST}:${process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379}`
	})

	const streamKey = 'agent-job-stream'
	const consumerGroup = 'agent-job-processors'
	const consumer = `consumer-${process.env.DEPLOYMENT_RUN_ID}`

	const processMessages = async () => {
		console.log(`[APP] Processing messages for runId: ${process.env.DEPLOYMENT_RUN_ID}`)
		try {
			// First try to find our specific message in pending messages
			const pendingMessage = await subscriberClient.xReadGroup(
				consumerGroup,
				consumer,
				[
					{
						key: streamKey,
						id: '0'
					}
				],
				{
					COUNT: 1
				}
			);

			if (pendingMessage && pendingMessage[0]?.messages[0]) {
				const message = pendingMessage[0].messages[0];
				const { data, runId } = message.message;

				if (runId === process.env.DEPLOYMENT_RUN_ID) {
					const parsedJobData = JSON.parse(Buffer.from(data, 'base64').toString());
					console.log(`[APP] Processing pending message for runId: ${runId}`);

					deploymentRunId = parsedJobData.deploymentRunId;
					services = parsedJobData.services;
					repository = parsedJobData.repository;
					latestDeployRun = parsedJobData.latestDeployRun;

					await processJob();
					await subscriberClient.xAck(streamKey, consumerGroup, message.id);
					await subscriberClient.disconnect();
					process.exit(0);
				}
				// If not our message, acknowledge and continue to new messages
				await subscriberClient.xAck(streamKey, consumerGroup, message.id);
			}

			// If we didn't find our message in pending, wait for new messages
			while (true) {
				console.log(`[APP] Waiting for new messages for runId: ${process.env.DEPLOYMENT_RUN_ID}`)
				const messages = await subscriberClient.xReadGroup(
					consumerGroup,
					consumer,
					[
						{
							key: streamKey,
							id: '>'
						}
					],
					{
						COUNT: 1,
						BLOCK: 5000
					}
				);

				if (!messages || messages.length === 0) continue;

				const message = messages[0].messages[0];
				const { data, runId } = message.message;

				console.log(`[APP] Received message for runId: ${runId}`);

				if (runId === process.env.DEPLOYMENT_RUN_ID) {
					const parsedJobData = JSON.parse(Buffer.from(data, 'base64').toString());
					console.log(`[APP] Processing message for runId: ${runId}`);

					deploymentRunId = parsedJobData.deploymentRunId;
					services = parsedJobData.services;
					repository = parsedJobData.repository;
					latestDeployRun = parsedJobData.latestDeployRun;

					await processJob();
					await subscriberClient.xAck(streamKey, consumerGroup, message.id);
					await subscriberClient.disconnect();
					process.exit(0);
					return;
				}
				// If not our message, acknowledge and continue
				await subscriberClient.xAck(streamKey, consumerGroup, message.id);
			}
		} catch (error) {
			console.error('Error processing message:', error);
			await subscriberClient.disconnect();
			process.exit(1);
		}
	}

	subscriberClient.on('error', (err: any) => console.error('Subscriber error:', err))
	subscriberClient.on('ready', async () => {
		console.info(`[APP] Subscriber connected to Redis`)
		processMessages().catch(console.error)
	})

	await subscriberClient.connect()
}