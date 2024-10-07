"use strict";
import { Octokit } from "@octokit/rest";
import axios from "axios";
import { exec } from "child_process";
import fs from "fs";
import pg from 'pg'
import yaml from 'yaml';
const { Pool } = pg
import { v4 } from 'uuid';
import os from "os";
import path from "path";

const pool = new Pool({
	host: 'postgres-gravity-service',
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
}

interface CLIOutput {
	command: string;
	output: string;
}

const terminalOutputs: CLIOutput[] = [];

const customExec = (command: string): Promise<string> => {
	return new Promise((resolve, reject) => {
		const process = exec(command);
		process.stdout?.on('data', (data) => {
			const output = data?.toString()?.trim() || "";
			terminalOutputs.push({ command: command, output: output });
			console.log(output);
		});
		process.stderr?.on('data', (data) => {
			const errorOutput = data?.toString()?.trim() || "";
			terminalOutputs.push({ command: command, output: errorOutput });
			console.error(errorOutput);
		});
		process.on('close', (code) => {
			if (code !== 0) {
				const error = new Error(`Process exited with code: ${code}`);
				console.error(error);
				reject(error);
			} else {
				resolve('Command executed successfully');
			}
		});
	});
};

const getGravityConfigFileFromRepo = async (repoData: any, githubToken: string) => {
	const gravityConfigFile = repoData.find((item: any) => item.name === "gravity.yaml");
	if (gravityConfigFile) {
		const response = await axios.get(gravityConfigFile.download_url, {
			headers: {
				"Authorization": `Bearer ${githubToken}`
			}
		});
		console.log("getGravityConfigFileFromRepo:", response.data);

		// convert the response.data from YAML to JSON
		const gravityConfigFileJson = yaml.parse(response.data);
		return gravityConfigFileJson;
	}
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

				const deploymentRunId = v4();

				try {
					if (latestDeployRun) {
						// check if this run was processed before from postgres db
						const checkIfProcessed = await client?.query("SELECT * FROM deployments WHERE actionId = $1 AND status IN ('COMPLETED', 'IN_PROGRESS')", [latestDeployRun.id]);
						if (checkIfProcessed?.rows && checkIfProcessed.rows.length > 0) {
							console.log("Run already processed");
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

						// build the docker image in sync with pushing the log output into array
						const dockerBuildCommand = `buildah --storage-driver vfs --isolation chroot bud --platform=linux/amd64 -t ${owner}/${serviceName}:latest -f ${gitRepoPath}/Dockerfile ${gitRepoPath}`;
						await customExec(dockerBuildCommand);

						console.log("dockerBuildCommand COMPLETED");

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
										try {
											const ecrBaseURL = `${process.env.AWS_ACCOUNT_ID}.dkr.ecr.${region}.amazonaws.com`

											// check if the ecr repository exists, if not create it
											try {
												await customExec(`AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID} AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY} aws ecr describe-repositories --repository-names ${awsRepositoryName} --region ${region}`);
											} catch (error) {
												console.error(`Error checking if repository ${awsRepositoryName} exists: ${error}`);
												await customExec(`AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID} AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY} aws ecr create-repository --repository-name ${awsRepositoryName} --region ${region}`);
											}

											// tag the docker image with the aws repository name and region
											const dockerTagCommand = `buildah --storage-driver vfs tag ${owner}/${serviceName}:latest ${ecrBaseURL}/${awsRepositoryName}:${latestDeployRun.id}`;
											await customExec(dockerTagCommand);

											const dockerPushCommand = `AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID} AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY} aws ecr get-login-password --region ${region} | buildah --storage-driver vfs login --username AWS --password-stdin ${ecrBaseURL} && buildah --storage-driver vfs push ${ecrBaseURL}/${awsRepositoryName}:${latestDeployRun.id}`;
											console.log("dockerPushCommand:", dockerPushCommand);
											await customExec(dockerPushCommand);

											const valueFileName = `values-${lastRunBranch}-${region}.yaml`;

											try {

												function findFile(dir: string, fileName: string): string | null {
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

												const valuesFilePath = findFile(gitRepoPath, valueFileName);
												if (!valuesFilePath) {
													console.error(`Values file ${valueFileName} not found`);
													return;
												}

												const valuesFileContent = fs.readFileSync(valuesFilePath, 'utf8');
												let parsedValuesFile = yaml.parse(valuesFileContent);
												parsedValuesFile.image.tag = latestDeployRun.id;

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

												newValuesFiles.push(JSON.stringify({ name: valueFileName, previousContent: valuesFileContent, newContent: yaml.stringify(parsedValuesFile) }));
												regions.push(region);
											} catch (error) {
												console.error(`Error updating ${valueFileName}: ${error}`);
												await client?.query("UPDATE deployments SET status = $1 WHERE runId = $2", ["FAILED", deploymentRunId]);
											}
										} catch (error) {
											console.error(`Error processing region ${region}: ${error}`);
											await client?.query("UPDATE deployments SET status = $1 WHERE runId = $2", ["FAILED", deploymentRunId]);
										}
									}));
								} catch (error) {
									console.error(`Error processing AWS repository ${repoDetails.name}: ${error}`);
									console.error('Stack trace:', error.stack);
									await client?.query("UPDATE deployments SET status = $1 WHERE runId = $2", ["FAILED", deploymentRunId]);
								}
							}));
						}

						// save the new values files in the database
						client = await getDbConnection();
						await client?.query(
							"UPDATE deployments SET destinations = $1, regions = $2, values_files = $3, status = $4 WHERE runId = $5",
							[destinations.join(','), regions.join(','), JSON.stringify(newValuesFiles), "COMPLETED", deploymentRunId]
						);
					}
				} catch (error) {
					console.error(`Error processing repository ${repository}: ${error}`);
					console.error('Stack trace:', error.stack);
					// mark the run as failed
					await client?.query("UPDATE deployments SET status = $1 WHERE runId = $2", ["FAILED", deploymentRunId]);
				}
			} catch (error) {
				console.error(`Error: ${error}`);
			}
		});
	} catch (error) {
		console.error(`Error in syncGitRepo: ${error}`);
	} finally {
		client?.release();
	}
};

syncGitRepo();
// setInterval(syncGitRepo, 10000);

// websocket to sync logs and updates to gravity server