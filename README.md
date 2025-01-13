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

4. You can also add `pre-deploy` scripts to run any commands before the deployment (such as linting, testing, etc.)
```yaml
metadata:
  name: mono-repo-js
spec:
  branch:
    - name: main
      approval: manual
    - name: development
      approval: automatic
    - name: feat-.*
      approval: automatic
  preDeploy:
    - name: run dummy script
      command: bash ./dummy.sh
  aws:
    repository:
      - name: mono-repo-js-east
        regions:
          - us-east-1
        branch: main
        valueFile:
          source: git
```

### Installing Gravity K8s Agent

```
helm upgrade --install gravity-cicd-agent https://gravitycloudai.github.io/gravity-k8s-ci-cd-agent -f ./chart/values.yaml -n gravity-cloud --create-namespace
```

### Custom Helm Charts (feature/dev environments)
1. Logon to Gravity UI and go to <kbd>Kubernetes</kbd> -> <kbd>Pipelines</kbd> -> <kbd>Pipeline Charts</kbd> OR visit [Console Here](https://console.gravitycloud.ai/kubernetes?tab=PIPELINES)

2. Click on <kbd>Create a new Pipeline Chart</kbd>
![Create a new Pipeline Chart](https://res.cloudinary.com/dor5uewzz/image/upload/v1731921421/k8s-pipeline-charts_p4wfiu.png)

3. Select the pre-defined chart and edit the values file as per your requirement
![Edit Pipeline Chart](https://res.cloudinary.com/dor5uewzz/image/upload/v1731921421/k8s-pipeline-charts-add_zoiaqo.png)

4. Once added, the agent will automatically sync the changes and deploy the helm chart to the respective environment when the new branch is created or updated.

5. Upon the deletion of the branch, the agent will delete the helm chart from the respective environment.


### Working
1. The agent syncs with the repository and checks if there are any new CI actions completed.
2. It then check the postgress database for the status of the deployment action (if completed previously, pending or failed)
3. Upon finding the need for a new deployment, it creates a Kubernetes Job for that deployment.
4. The K8s job will generate the Docker image (along with cache stored in local docker registry), and then iterates through the cloud accounts, regions while tagging and pushin them into the repositories.
5. It will go and update the Values file in your git or Update the S3 values file along with the ArgoCD manifest file.
6. In the whole workflow, Slack notifications can be setup as per your requirement.
7. In the whole workflow, you can sync the deployment process with Gravity UI also.

## Links
1. Docker Hub: https://hub.docker.com/r/gravitycloud/gravity-ci-cd-agent
2. Website: https://gravitycloud.ai
3. Discord: https://discord.gg/fJU5DvanU3



