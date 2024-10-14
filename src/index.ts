"use strict";
import { Octokit } from "@octokit/rest";
import axios from "axios";
import { spawn } from "child_process";
import fs from "fs";
import pg from 'pg'
import yaml from 'yaml';
const { Pool } = pg
import { v4 } from 'uuid';
import os from "os";
import path from "path";
import { io, Socket } from 'socket.io-client';

const pool = new Pool({
	host: process.env.POSTGRES_HOST,
	database: process.env.POSTGRES_DB,
	user: process.env.POSTGRES_USER,
	password: process.env.POSTGRES_PASSWORD,
	port: 5432,
});

// Replace getDbConnection function
async function getDbConnection() {
	return await pool.connect();
}

(async () => {
	const client = await getDbConnection();
	try {
		const tableExistsQuery = `
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_name = 'deployments'
            );
        `;
		const { rows } = await client.query(tableExistsQuery);
		if (!rows[0].exists) {
			console.log("Table 'deployments' does not exist, creating table");
			const createTableQuery = `
                CREATE TABLE deployments (
                    runId TEXT PRIMARY KEY,
                    actionId TEXT,
										commit_id TEXT,
                    repository_name TEXT,
                    branch TEXT,
                    destinations TEXT,
                    regions TEXT,
                    values_files TEXT,
                    status TEXT,
					user_id TEXT,
					user_details TEXT,
					created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `;
			await client.query(createTableQuery);
			console.log("Table 'deployments' created successfully");
		} else {
			console.log("Table 'deployments' already exists");
		}
	} catch (err) {
		console.error("Error checking or creating table:", err);
	} finally {
		client.release();
	}
})();

interface AWSRepository {
	name: string;
	regions: string[];
	branch: string;
	valueFile: {
		source: string;
		bucket?: string;
	};
}

const findFile = (dir: string, fileName: string): string | null => {
	const files = fs.readdirSync(dir);
	for (const file of files) {
		const filePath = path.join(dir, file);
		const stat = fs.statSync(filePath);
		if (stat.isDirectory()) {
			const found = findFile(filePath, fileName);
			if (found) return found;
		} else if (file === fileName) {
			return filePath;
		}
	}
	return null;
}

const syncLogsToGravityViaWebsocket = async (runId: string, action: string, message: string, isError: boolean = false) => {
	if (socket && socket.connected) {
		socket.emit('log', { runId, action, message, gravityApiKey: process.env.GRAVITY_API_KEY, timestamp: new Date().toISOString(), isError });
	}
}

const customExec = (runId: string, action: string, command: string, skipLogging: boolean = false): Promise<string> => {
	return new Promise((resolve, reject) => {
		console.log(`Executing command: ${command}`);
		const process = spawn(command, [], { shell: true });

		let output = '';

		const handleOutput = (data: Buffer) => {
			const chunk = data.toString().trim();
			output += chunk + '\n';
			console.log(chunk);
			if (!skipLogging) {
				if (chunk) {
					syncLogsToGravityViaWebsocket(runId, action, JSON.stringify(chunk), false);
				}
			}
		};

		process.stdout.on('data', (data) => handleOutput(data));
		process.stderr.on('data', (data) => handleOutput(data));

		process.on('error', (error) => {
			console.error(error);
			syncLogsToGravityViaWebsocket(runId, action, JSON.stringify(error.message), true);
			reject(error);
		});

		process.on('close', (code) => {
			console.log(`Process exited with code: ${code}`);
			if (code !== 0) {
				const error = new Error(`Process exited with code: ${code}`);
				console.error(error);
				syncLogsToGravityViaWebsocket(runId, action, JSON.stringify(error.message), true);
				reject(error);
			} else {
				resolve(output);
			}
		});
	});
};

let socket: Socket | null = null;

if (process.env.GRAVITY_API_KEY) {
	socket = io(process.env.GRAVITY_WEBSOCKET_URL, {
		transports: ['websocket'],
		reconnection: true,
		reconnectionAttempts: 5,
		reconnectionDelay: 1000,
		timeout: 10000
	});

	socket.on('connect', () => {
		console.log("Socket.IO connection opened");
	});

	socket.on('connect_error', (error: any) => {
		console.error(`Socket.IO connection error: ${error}`);
		console.error(`Error details: ${JSON.stringify(error)}`);
	});

	socket.on('disconnect', (reason: any) => {
		console.log(`Socket.IO connection closed: ${reason}`);
	});

	socket.on('reconnect_attempt', (attemptNumber: number) => {
		console.log(`Socket.IO reconnection attempt ${attemptNumber}`);
	});

	socket.on('reconnect_failed', () => {
		console.error("Socket.IO failed to reconnect after all attempts");
	});
}

const getGravityConfigFileFromRepo = async (repoData: any, githubToken: string) => {
	const gravityConfigFile = repoData.find((item: any) => item.name === "gravity.yaml");
	if (gravityConfigFile) {
		const response = await axios.get(gravityConfigFile.download_url, {
			headers: {
				"Authorization": `Bearer ${githubToken}`
			}
		});
		console.log("Gravity Config File:", response.data);

		// convert the response.data from YAML to JSON
		const gravityConfigFileJson = yaml.parse(response.data);
		return gravityConfigFileJson;
	}
};

const sendSlackNotification = async (title: string, message: string) => {
	if (!process.env.SLACK_WEBHOOK_URL) {
		console.log("Slack webhook URL not found, skipping notification");
		return;
	}
	const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;
	await axios.post(slackWebhookUrl, { text: `*${title}*\n${message}` });
};

// sync git repo every 10 seconds
const syncGitRepo = async () => {
	let client: pg.PoolClient | null = null;
	try {
		client = await getDbConnection();
		const githubToken = process.env.GITHUB_TOKEN!!;
		const githubRepositories = process.env.GITHUB_REPOSITORIES!!;
		const octokit = new Octokit({ auth: githubToken });

		githubRepositories.split(",").forEach(async (repository) => {
			try {
				const [owner, repo] = repository.split('/');

				// get the github actions status
				const githubActionsStatus = await axios.get(`https://api.github.com/repos/${repository}/actions/runs`, {
					headers: {
						"Authorization": `Bearer ${githubToken}`
					}
				});

				const latestDeployRun = githubActionsStatus.data.workflow_runs
					.filter((run: any) => run.name === "Deploy" && run.status === "completed")
					.sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];

				const gitBranchesAllowed = process.env.GIT_BRANCHES_ALLOWED!!.split(",");
				if (!gitBranchesAllowed.includes(latestDeployRun.head_branch)) {
					console.log(`Branch ${latestDeployRun.head_branch} not in allowed list, skipping`);
					return;
				}

				const deploymentRunId = v4();

				try {
					if (latestDeployRun) {
						// check if this run was processed before from postgres db
						const checkIfProcessed = await client?.query("SELECT * FROM deployments WHERE actionId = $1 AND status IN ('COMPLETED', 'IN_PROGRESS')", [latestDeployRun.id]);
						if (checkIfProcessed?.rows && checkIfProcessed.rows.length > 0) {
							console.log("Run already processed, skipping.");
							return;
						}

						// create a new db entry for this run with status as pending
						const userDetails = {
							id: latestDeployRun?.actor?.id,
							login: latestDeployRun?.actor?.login,
							avatar_url: latestDeployRun?.actor?.avatar_url,
							html_url: latestDeployRun?.actor?.html_url,
							type: latestDeployRun?.actor?.type
						};

						await client?.query("INSERT INTO deployments (runId, actionId, commit_id, repository_name, branch, destinations, regions, values_files, status, user_id, user_details) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)", [deploymentRunId, latestDeployRun.id, latestDeployRun?.head_commit?.id, repository, latestDeployRun?.head_branch, "", "", "", "IN_PROGRESS", latestDeployRun?.actor?.id, JSON.stringify(userDetails)]);

						syncLogsToGravityViaWebsocket(deploymentRunId, "PIPELINE_CREATED", JSON.stringify({ deploymentRunId, actionId: latestDeployRun.id, commitId: latestDeployRun?.head_commit?.id, repository, branch: latestDeployRun?.head_branch, userDetails: JSON.stringify(userDetails) }));

						const gitRepo = await axios.get(`https://api.github.com/repos/${repository}/contents/`, {
							headers: {
								"Authorization": `Bearer ${githubToken}`
							}
						});
						const gravityConfigFile = await getGravityConfigFileFromRepo(gitRepo.data, githubToken);

						// get the repo name, all branches and aws repository names and regions from gravity.yaml
						const serviceName = gravityConfigFile.metadata.name;
						const branches = gravityConfigFile.spec.branch;

						// check if the last run branch includes the list of branches in gravity.yaml
						const lastRunBranch = latestDeployRun.head_branch;
						const isBranchInGravityYaml = branches.some((branch: any) => branch.name === lastRunBranch);
						if (!isBranchInGravityYaml) {
							console.log("Branch not in gravity.yaml");
							return;
						}

						// download the git repo in temp folder
						const tempDir = os.tmpdir();
						const gitRepoPath = path.join(tempDir, repository.replace('/', '-'));
						if (!fs.existsSync(gitRepoPath)) {
							fs.mkdirSync(gitRepoPath, { recursive: true });
						}

						// download all files from the git repo
						async function downloadFile(file: any, path: string) {
							if (file.type === "file") {
								const fileContent = await axios.get(file.download_url, {
									headers: {
										"Authorization": `Bearer ${githubToken}`
									},
									responseType: 'text'
								});
								fs.writeFileSync(path, fileContent.data);
							} else if (file.type === "dir") {
								fs.mkdirSync(path, { recursive: true });
								const dirContent = await axios.get(file.url, {
									headers: {
										"Authorization": `Bearer ${githubToken}`
									}
								});
								await Promise.all(dirContent.data.map((item: any) =>
									downloadFile(item, `${path}/${item.name}`)
								));
							}
						}

						await Promise.all(gitRepo.data.map(async (item: any) =>
							downloadFile(item, `${gitRepoPath}/${item.name}`)
						));

						let dockerBuildCli = "docker";
						if (process.env.ENV === "production") {
							dockerBuildCli = "buildah --storage-driver vfs --isolation chroot";
						}

						// build the docker image in sync with pushing the log output into array
						const dockerBuildCommand = `${dockerBuildCli} ${process.env.ENV === "production" ? "bud" : "build"} --platform=linux/amd64 -t ${owner}/${serviceName}:latest -f ${gitRepoPath}/Dockerfile ${gitRepoPath}`;
						await customExec(deploymentRunId, "DOCKER_IMAGE_BUILD", dockerBuildCommand);

						console.log("dockerBuildCommand COMPLETED");

						sendSlackNotification("Docker Build Completed", `Docker build completed for ${repository}`);

						const newValuesFiles: string[] = [];
						const destinations: string[] = [];
						const regions: string[] = [];

						// check if the gravity.yaml contains aws in the spec
						if (gravityConfigFile?.spec?.aws) {
							destinations.push("AWS");

							// push the docker image for each aws repository
							await Promise.all(gravityConfigFile?.spec?.aws?.repository?.map(async (repoDetails: AWSRepository) => {
								try {
									const awsRepositoryName = repoDetails?.name;
									const awsRepositoryRegions = repoDetails?.regions;
									const awsRepositoryBranch = repoDetails?.branch;

									// check if the branch is the same as the last run branch
									if (awsRepositoryBranch !== lastRunBranch) {
										console.log("Current branch is not the same as the last run branch, skipping deployment");
										return;
									}

									await Promise.all(awsRepositoryRegions.map(async (region) => {
										regions.push(region);

										try {
											const ecrBaseURL = `${process.env.AWS_ACCOUNT_ID}.dkr.ecr.${region}.amazonaws.com`

											// check if the ecr repository exists, if not create it
											try {
												await customExec(deploymentRunId, "ECR_REPOSITORY_CHECK", `AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID} AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY} aws ecr describe-repositories --repository-names ${awsRepositoryName} --region ${region}`);
											} catch (error) {
												console.error(`Error checking if repository ${awsRepositoryName} exists: ${error}`);
												console.log("Creating repository...");
												await customExec(deploymentRunId, "ECR_REPOSITORY_CREATE", `AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID} AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY} aws ecr create-repository --repository-name ${awsRepositoryName} --region ${region}`);
											}

											// tag the docker image with the aws repository name and region
											const dockerTagCommand = `${dockerBuildCli} tag ${owner}/${serviceName}:latest ${ecrBaseURL}/${awsRepositoryName}:${latestDeployRun.head_sha}`;
											await customExec(deploymentRunId, "DOCKER_IMAGE_TAG", dockerTagCommand);

											const dockerPushCommand = `AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID} AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY} aws ecr get-login-password --region ${region} | ${dockerBuildCli} login --username AWS --password-stdin ${ecrBaseURL} && ${dockerBuildCli} push ${ecrBaseURL}/${awsRepositoryName}:${latestDeployRun.head_sha}`;
											await customExec(deploymentRunId, "DOCKER_IMAGE_PUSH", dockerPushCommand);

											sendSlackNotification("Docker Push Completed", `Docker push completed for ${repository} in ${region}`);

											if (repoDetails?.valueFile?.source === "git") {
												const valueFileName = `values-${lastRunBranch}-${region}.yaml`;

												try {
													const valuesFilePath = findFile(gitRepoPath, valueFileName);
													if (!valuesFilePath) {
														console.error(`Values file ${valueFileName} not found`);
														return;
													}

													const valuesFileContent = fs.readFileSync(valuesFilePath, 'utf8');
													let parsedValuesFile = yaml.parse(valuesFileContent);
													parsedValuesFile.image.tag = latestDeployRun.head_sha;

													const relativePath = path.relative(gitRepoPath, valuesFilePath);

													// Fetch the current file to get its SHA
													const { data: currentFile } = await octokit.repos.getContent({
														owner,
														repo,
														path: relativePath,
														ref: lastRunBranch
													});

													if (Array.isArray(currentFile)) {
														console.error(`${relativePath} is a directory, not a file`);
														return;
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
													});

													console.log(`Updated ${valueFileName} for ${lastRunBranch} in ${region}`);
													sendSlackNotification("Values File Updated", `Updated ${valueFileName} for ${lastRunBranch} in ${region}`);

													newValuesFiles.push(JSON.stringify({ name: valueFileName, previousContent: valuesFileContent, newContent: yaml.stringify(parsedValuesFile) }));
												} catch (error) {
													console.error(`Error updating ${valueFileName}: ${error}`);
													await client?.query("UPDATE deployments SET status = $1 WHERE runId = $2", ["FAILED", deploymentRunId]);
													sendSlackNotification("Values File Update Failed", `Error updating ${valueFileName} for ${lastRunBranch} in ${region}: ${error}`);
												}
											} else if (repoDetails?.valueFile?.source === "s3") {
												try {
													let latestValueFileFromS3Bucket = await customExec(deploymentRunId, "UPDATING_VALUES_FILE", `AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID} AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY} aws s3api list-objects-v2 --bucket ${repoDetails?.valueFile?.bucket} --query 'sort_by(Contents, &LastModified)[-1].Key' --output text`, true);

													if (!latestValueFileFromS3Bucket) {
														console.error(`No value file found in ${repoDetails?.valueFile?.bucket}`);
														return;
													}
													latestValueFileFromS3Bucket = latestValueFileFromS3Bucket.trim();

													const tempDir = os.tmpdir();
													const localFilePath = path.join(tempDir, path.basename(latestValueFileFromS3Bucket));

													await customExec(deploymentRunId, "UPDATING_VALUES_FILE", `AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID} AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY} aws s3 cp s3://${repoDetails?.valueFile?.bucket}/${latestValueFileFromS3Bucket} ${localFilePath}`, true);

													const valuesFileContent = fs.readFileSync(localFilePath, 'utf8');

													if (!valuesFileContent) {
														console.error(`Error getting values file content from ${repoDetails?.valueFile?.bucket}`);
														return;
													}

													let parsedValuesFile = yaml.parse(valuesFileContent);
													parsedValuesFile.image.tag = latestDeployRun.head_sha;

													// create a temporary file with the new values file content with same name as the original one
													fs.writeFileSync(localFilePath, yaml.stringify(parsedValuesFile));

													// upload the temporary file to the s3 bucket
													try {
														console.log(`Updating S3 file: ${repoDetails?.valueFile?.bucket}/${latestValueFileFromS3Bucket}`);

														// First, delete the existing file
														console.log(`Deleting existing S3 file: ${repoDetails?.valueFile?.bucket}/${latestValueFileFromS3Bucket}`);
														const s3DeleteCommand = `AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID} AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY} aws s3 rm s3://${repoDetails?.valueFile?.bucket}/${latestValueFileFromS3Bucket}`;
														await customExec(deploymentRunId, "DELETING_S3_FILE", s3DeleteCommand, true);
														console.log(`Successfully deleted existing S3 file: ${repoDetails?.valueFile?.bucket}/${latestValueFileFromS3Bucket}`);

														// Then, upload the new file
														console.log(`Uploading new S3 file: ${repoDetails?.valueFile?.bucket}/${latestValueFileFromS3Bucket}`);
														const s3UploadCommand = `AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID} AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY} aws s3 cp ${localFilePath} s3://${repoDetails?.valueFile?.bucket}/${latestValueFileFromS3Bucket}`;
														await customExec(deploymentRunId, "UPLOADING_S3_FILE", s3UploadCommand, true);
														console.log(`Successfully uploaded new values file to S3 bucket: ${repoDetails?.valueFile?.bucket}/${latestValueFileFromS3Bucket}`);

													} catch (error) {
														console.error(`Failed to update values file in S3 bucket: ${error}`);
														await client?.query("UPDATE deployments SET status = $1 WHERE runId = $2", ["FAILED", deploymentRunId]);
														syncLogsToGravityViaWebsocket(deploymentRunId, "PIPELINE_FAILED", JSON.stringify({ error: `S3 file update failed: ${error.message}` }), true);
														sendSlackNotification("Values File Update Failed", `Error updating values file in S3 bucket for ${lastRunBranch} in ${region}: ${error}`);
														throw error;
													}

													newValuesFiles.push(JSON.stringify({ name: latestValueFileFromS3Bucket, previousContent: valuesFileContent, newContent: yaml.stringify(parsedValuesFile) }));

													// delete the temporary file
													fs.unlinkSync(localFilePath);

													const argoManifestFileName = `argo-${serviceName}-${lastRunBranch}-${region}.yaml`;

													// get the argo manifest file from the git repo
													const argoManifestFilePath = findFile(gitRepoPath, argoManifestFileName);
													if (!argoManifestFilePath) {
														console.error(`Values file ${argoManifestFileName} not found`);
														return;
													}

													const argoManifestFileContent = fs.readFileSync(argoManifestFilePath, 'utf8');
													let parsedArgoManifestFile = yaml.parse(argoManifestFileContent);
													parsedArgoManifestFile.spec.source.helm.valueFiles = `https://${repoDetails?.valueFile?.bucket}.s3.amazonaws.com/${latestValueFileFromS3Bucket}`;

													// update the argo manifest file with the new values file
													fs.writeFileSync(argoManifestFilePath, yaml.stringify(parsedArgoManifestFile));

													const relativePath = path.relative(gitRepoPath, argoManifestFilePath);

													// Fetch the current file to get its SHA
													const { data: currentFile } = await octokit.repos.getContent({
														owner,
														repo,
														path: relativePath,
														ref: lastRunBranch
													});

													if (Array.isArray(currentFile)) {
														console.error(`${relativePath} is a directory, not a file`);
														return;
													}

													// this method does not trigger workflow dispatch event
													await octokit.repos.createOrUpdateFileContents({
														owner,
														repo,
														path: relativePath,
														message: `[skip ci] Updated Argo Manifest file for ${lastRunBranch} in ${region} for deployment ${latestDeployRun.id}`,
														content: Buffer.from(yaml.stringify(parsedArgoManifestFile)).toString('base64'),
														sha: currentFile.sha,
														branch: lastRunBranch
													});

													console.log(`Updated ${argoManifestFileName} for ${lastRunBranch} in ${region}`);
													sendSlackNotification("Argo Manifest File Updated", `Updated ${argoManifestFileName} for ${lastRunBranch} in ${region}`);

												} catch (error) {
													console.error(`Error updating ${repoDetails?.valueFile?.bucket}: ${error}`);
													await client?.query("UPDATE deployments SET status = $1 WHERE runId = $2", ["FAILED", deploymentRunId]);
													sendSlackNotification("Argo Manifest File Update Failed", `Error updating ${repoDetails?.valueFile?.bucket} for ${lastRunBranch} in ${region}: ${error}`);
												}
											}

										} catch (error) {
											console.error(`Error processing region ${region}: ${error}`);
											await client?.query("UPDATE deployments SET status = $1 WHERE runId = $2", ["FAILED", deploymentRunId]);
											syncLogsToGravityViaWebsocket(deploymentRunId, "PIPELINE_FAILED", JSON.stringify({ error: error.message }), true);
											sendSlackNotification("Deployment Failed", `Error processing region ${region} for ${repository}: ${error}`);
										}
									}));
								} catch (error) {
									console.error(`Error processing AWS repository ${repoDetails.name}: ${error}`);
									console.error('Stack trace:', error.stack);
									await client?.query("UPDATE deployments SET status = $1 WHERE runId = $2", ["FAILED", deploymentRunId]);
									syncLogsToGravityViaWebsocket(deploymentRunId, "PIPELINE_FAILED", JSON.stringify({ error: error.message }), true);
									sendSlackNotification("Deployment Failed", `Error processing AWS repository ${repoDetails.name} for ${repository}: ${error}`);
								}
							}));
						}

						// save the new values files in the database
						client = await getDbConnection();
						await client?.query(
							"UPDATE deployments SET destinations = $1, regions = $2, values_files = $3, status = $4 WHERE runId = $5",
							[destinations.join(','), regions.join(','), JSON.stringify(newValuesFiles), "COMPLETED", deploymentRunId]
						);

						syncLogsToGravityViaWebsocket(deploymentRunId, "PIPELINE_COMPLETED", JSON.stringify({ newValuesFiles, destinations, regions }), false);
					}
				} catch (error) {
					console.error(`Error processing repository ${repository}: ${error}`);
					console.error('Stack trace:', error.stack);
					// mark the run as failed
					await client?.query("UPDATE deployments SET status = $1 WHERE runId = $2", ["FAILED", deploymentRunId]);
					syncLogsToGravityViaWebsocket(deploymentRunId, "PIPELINE_FAILED", JSON.stringify({ error: error.message }), true);
					sendSlackNotification("Deployment Failed", `Error processing repository ${repository}: ${error}`);
				}
			} catch (error) {
				console.error(`Error: ${error}`);
			}
		});
	} catch (error) {
		console.error(`Error in syncGitRepo: ${error}`);
		sendSlackNotification("Deployment Failed", `Error in syncGitRepo: ${error}`);
	} finally {
		client?.release();
	}
};

setInterval(syncGitRepo, 30000);