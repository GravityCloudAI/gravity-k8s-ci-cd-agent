# Gravity CI/CD Agent for ArgoCD
Gravity Agent for k8s is a multi-cloud and multi-region deployment tool. It enables easy replication of applications, low-code CI/CD setup on top of ArgoCD.

![Gravity CI/CD Pipelines](https://res.cloudinary.com/dor5uewzz/image/upload/v1728963598/gravity-ui-k8s-pipeline_wvpx4m.png)

![Gravity CI/CD Logs](https://res.cloudinary.com/dor5uewzz/image/upload/v1728963598/gravity-ui-k8s-logs_y4wrxb.png)

## Setup

### Github Repository
1. Add the `gravity.yaml` file to the root of your repository.
2. Make the changes as per your app

You can use the following example as a template:
```yaml
metadata:
  name: nodejs-app
spec:
  branch:
    - name: main
      approval: manual
    - name: development
      approval: automatic
  aws:
    repository:
      - name: nodejs-app-east
        regions:
          - us-east-1
        branch: main
        valueFile:
          source: s3
          bucket: gravity-app-prod-values
```

> If you are using Github to store the values file, you can use the following example to setup the repository:

```yaml
metadata:
  name: nodejs-app
spec:
  branch:
    - name: main
      approval: manual
    - name: development
      approval: automatic
  aws:
    repository:
      - name: nodejs-app-east
        regions:
          - us-east-1
        branch: main
        valueFile:
          source: git
```
3. Update Github Action workflow with name as `Deploy` and only run CI, tests and any business logic to generate values file (such as secrets, no need to manage docker images)


### Gravity K8s Agent
1. Update the `example.env` file with the required variables.
```
GRAVITY_API_KEY=
GITHUB_TOKEN=
GITHUB_REPOSITORIES=array-separated-by-comma,second-repo
AWS_ACCESS_KEY_ID=access-key-with-ecr-login-and-push-permissions
AWS_SECRET_ACCESS_KEY=
AWS_ACCOUNT_ID=
POSTGRES_HOST=postgres-gravity-service
POSTGRES_DB=postgres
POSTGRES_USER=
POSTGRES_PASSWORD=
SLACK_WEBHOOK_URL=
ENV=production
GRAVITY_WEBSOCKET_URL=wss://api.gravitycloud.ai
GIT_BRANCHES_ALLOWED=main,staging
```
2. Run `export $(grep -v '^#' example.env | xargs) && envsubst < deployment.yaml > deployment_subst.yaml` to generate the deployment.yaml file with the actual values.
3. Deploy the application to Kubernetes using `kubectl apply -f deployment_subst.yaml`.

### Working
1. The agent syncs with the repository and checks if there are any new CI actions completed.
2. It then check the postgress database for the status of the deployment action (if completed previously, pending or failed)
3. Generates the Docker file, and then iterates through the cloud accounts, regions while tagging and pushin them into the repositories.
4. It will go and update the Values file in your git or Update the S3 values file along with the ArgoCD manifest file.
5. In the whole workflow, Slack notifications can be setup as per your requirement.
6. In the whole workflow, you can sync the deployment process with Gravity UI also.



## Links
1. Docker Hub: https://hub.docker.com/r/gravitycloud/gravity-ci-cd-agent
2. Website: https://gravitycloud.ai
3. Discord: https://discord.gg/fJU5DvanU3



