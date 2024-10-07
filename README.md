# Gravity Deployment Sync Documentation

## Overview

This TypeScript file (`src/index.ts`) is responsible for synchronizing GitHub repositories with AWS ECR (Elastic Container Registry) and managing deployments. It performs the following main tasks:

1. Initializes a PostgreSQL database connection
2. Creates a 'deployments' table if it doesn't exist
3. Syncs Git repositories
4. Builds and pushes Docker images to AWS ECR
5. Updates values files in the GitHub repository

## Main Components

### Database Connection

- Uses `pg` library to connect to a PostgreSQL database
- Connection details are hardcoded (consider using environment variables for security)

### Database Initialization

- Checks if the 'deployments' table exists
- Creates the table if it doesn't exist

### Custom Execution Function

- `customExec`: Executes shell commands and captures output

### GitHub Integration

- Uses `@octokit/rest` for GitHub API interactions
- Fetches repository contents and workflow runs

### AWS Integration

- Interacts with AWS ECR to push Docker images
- Uses AWS CLI commands for ECR operations

### Main Sync Function

- `syncGitRepo`: The core function that orchestrates the entire sync process

## Key Functions

### `getGravityConfigFileFromRepo`

Fetches and parses the `gravity.yaml` file from a GitHub repository.

### `syncGitRepo`

Main function that:
1. Fetches the latest completed "Deploy" workflow run
2. Checks if the run has been processed before
3. Creates a new deployment entry in the database
4. Downloads the repository contents
5. Builds a Docker image
6. Pushes the image to AWS ECR for each specified region
7. Updates values files in the GitHub repository
8. Updates the deployment status in the database

## Workflow

1. The script connects to the database and ensures the 'deployments' table exists
2. It then calls `syncGitRepo` once (commented out setInterval suggests it was meant to run periodically)
3. `syncGitRepo` processes each repository specified in the `GITHUB_REPOSITORIES` environment variable
4. For each repository, it checks for new deployments, builds and pushes Docker images, and updates values files

## Notes

- Sensitive information (tokens, AWS credentials) is hardcoded. This should be replaced with secure environment variables or secret management.
- Error handling is implemented throughout the script, with errors logged to the console.
- The script uses a mix of `async/await` and Promises for asynchronous operations.
- A websocket for syncing logs and updates is mentioned in a comment but not implemented in the provided code.

## Potential Improvements

1. Implement the websocket for real-time log and update syncing
3. Add more comprehensive error handling and recovery mechanisms
4. Consider breaking down the `syncGitRepo` function into smaller, more manageable functions
5. Implement retry logic for network operations that might fail transiently
6. Add more detailed logging and potentially integrate with a logging service