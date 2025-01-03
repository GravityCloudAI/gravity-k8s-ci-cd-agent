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

### Gravity K8s Agent

1. Update the `example.env` file with the required variables.
```
GRAVITY_API_KEY=
GRAVITY_API_URL=https://api.gravitycloud.ai
GRAVITY_WEBSOCKET_URL=wss://api.gravitycloud.ai
GITHUB_TOKEN=
GITHUB_REPOSITORIES=array-separated-by-comma,second-repo
GITHUB_JOB_NAME=Deploy
AWS_ACCESS_KEY_ID=access-key-with-ecr-login-and-push-permissions
AWS_SECRET_ACCESS_KEY=
AWS_ACCOUNT_ID=
POSTGRES_HOST=postgres-gravity-service
POSTGRES_PORT=5432
POSTGRES_DB=postgres
POSTGRES_USER=
POSTGRES_PASSWORD=
SLACK_WEBHOOK_URL=
ENV=production
GRAVITY_WEBSOCKET_URL=wss://api.gravitycloud.ai
GIT_BRANCHES_ALLOWED=main,staging,feat-.*
ARGOCD_URL=http://argocd-server.argocd.svc.cluster.local
ARGOCD_TOKEN=XXXX
REDIS_HOST=redis-gravity-service
REDIS_PORT=6379
REDIS_PASSWORD=
NAMESPACE=gravity
```

2. Make any required changes to the `deployment.yaml` file.
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: gravity-ci-cd-agent
  namespace: ${NAMESPACE}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: gravity-ci-cd-agent
  template:
    metadata:
      labels:
        app: gravity-ci-cd-agent
    spec:
      restartPolicy: Always
      serviceAccountName: gravity-job-agent-sa
      initContainers:
        - name: wait-for-postgres
          image: busybox:1.28
          command:
            [
              "sh",
              "-c",
              "echo 'Waiting for services...' && \
              while ! nc -z -w 2 $POSTGRES_HOST ${POSTGRES_PORT:-5432} || ! nc -z -w 2 $REDIS_HOST ${REDIS_PORT:-6379}; do \
                echo 'Checking services:'; \
                nc -z -w 2 $POSTGRES_HOST ${POSTGRES_PORT:-5432} || echo '- Postgres not ready'; \
                nc -z -w 2 $REDIS_HOST ${REDIS_PORT:-6379} || echo '- Redis not ready'; \
                sleep 5; \
              done; \
              echo 'All services are ready!'"
            ]
          env:
            - name: POSTGRES_HOST
              value: "${POSTGRES_HOST}"
            - name: REDIS_HOST
              value: "${REDIS_HOST}"
            - name: POSTGRES_PORT
              value: "${POSTGRES_PORT}"
            - name: REDIS_PORT
              value: "${REDIS_PORT}"
      containers:
        - name: gravity-ci-cd-agent
          image: gravitycloud/gravity-ci-cd-agent:latest
          imagePullPolicy: Always
          env:
            - name: GRAVITY_API_KEY # OPTIONAL: To sync logs, errors, and reports with Gravity UI
              value: "${GRAVITY_API_KEY}"
            - name: GRAVITY_WEBSOCKET_URL # OPTIONAL: To sync logs, errors, and reports with Gravity UI
              value: "${GRAVITY_WEBSOCKET_URL}"
            - name: GRAVITY_API_URL
              value: "${GRAVITY_API_URL}"
            - name: ENV
              value: "${ENV}"
            - name: GITHUB_TOKEN
              value: "${GITHUB_TOKEN}"
            - name: GITHUB_REPOSITORIES
              value: "${GITHUB_REPOSITORIES}"
            - name: GIT_BRANCHES_ALLOWED
              value: "${GIT_BRANCHES_ALLOWED}"
            - name: GITHUB_JOB_NAME
              value: "${GITHUB_JOB_NAME}"
            - name: AWS_ACCESS_KEY_ID
              value: "${AWS_ACCESS_KEY_ID}"
            - name: AWS_SECRET_ACCESS_KEY
              value: "${AWS_SECRET_ACCESS_KEY}"
            - name: AWS_ACCOUNT_ID
              value: "${AWS_ACCOUNT_ID}"
            - name: POSTGRES_HOST
              value: "${POSTGRES_HOST}"
            - name: POSTGRES_USER
              value: "${POSTGRES_USER}"
            - name: POSTGRES_PASSWORD
              value: "${POSTGRES_PASSWORD}"
            - name: POSTGRES_DB
              value: "${POSTGRES_DB}"
            - name: POSTGRES_PORT
              value: "${POSTGRES_PORT}"
            - name: REDIS_HOST
              value: "${REDIS_HOST}"
            - name: REDIS_PORT
              value: "${REDIS_PORT}"
            - name: REDIS_PASSWORD
              value: "${REDIS_PASSWORD}"
            - name: SLACK_WEBHOOK_URL
              value: "${SLACK_WEBHOOK_URL}"
            - name: ARGOCD_URL
              value: "${ARGOCD_URL}"
            - name: ARGOCD_TOKEN
              value: "${ARGOCD_TOKEN}"
            - name: NAMESPACE
              value: "${NAMESPACE}"
            - name: DOCKER_REGISTRY_URL
              value: "${DOCKER_REGISTRY_URL}"
            - name: DOCKER_REGISTRY_PORT
              value: "${DOCKER_REGISTRY_PORT}"
          resources:
            requests:
              memory: "512Mi"
              cpu: "512m"
            limits:
              memory: "8192Mi"
              cpu: "4000m"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres-gravity
  namespace: ${NAMESPACE}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: postgres-gravity
  template:
    metadata:
      labels:
        app: postgres-gravity
    spec:
      restartPolicy: Always
      containers:
        - name: postgres-gravity
          image: postgres:latest
          imagePullPolicy: IfNotPresent
          env:
            - name: POSTGRES_DB
              value: "${POSTGRES_DB}"
            - name: POSTGRES_USER
              value: "${POSTGRES_USER}"
            - name: POSTGRES_PASSWORD
              value: "${POSTGRES_PASSWORD}"
          ports:
            - containerPort: 5432
          resources:
            requests:
              memory: "1Gi"
              cpu: "500m"
            limits:
              memory: "2Gi"
              cpu: "1000m"
          volumeMounts:
            - name: postgres-gravity-storage
              mountPath: /var/lib/postgresql/data
              subPath: postgres
      volumes:
        - name: postgres-gravity-storage
          persistentVolumeClaim:
            claimName: postgres-gravity-pvc
---
apiVersion: v1
kind: Service
metadata:
  name: postgres-gravity-service
  namespace: ${NAMESPACE}
spec:
  selector:
    app: postgres-gravity
  ports:
    - protocol: TCP
      port: 5432
      targetPort: 5432
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis-gravity
  namespace: ${NAMESPACE}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: redis-gravity
  template:
    metadata:
      labels:
        app: redis-gravity
    spec:
      restartPolicy: Always
      containers:
        - name: redis-gravity
          image: redis:latest
          command: ["/bin/sh", "-c", "redis-server --requirepass $REDIS_PASSWORD"]
          env:
            - name: REDIS_PASSWORD
              value: "${REDIS_PASSWORD}"
          ports:
            - containerPort: 6379
          resources:
            requests:
              memory: "256Mi"
              cpu: "250m"
            limits:
              memory: "512Mi"
              cpu: "500m"
          volumeMounts:
            - name: redis-gravity-storage
              mountPath: /data
      volumes:
        - name: redis-gravity-storage
          persistentVolumeClaim:
            claimName: redis-gravity-pvc
---
apiVersion: v1
kind: Service
metadata:
  name: redis-gravity-service
  namespace: ${NAMESPACE}
spec:
  selector:
    app: redis-gravity
  ports:
    - protocol: TCP
      port: 6379
      targetPort: 6379
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: redis-gravity-pvc
  namespace: ${NAMESPACE}
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
  storageClassName: standard
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-gravity-pvc
  namespace: ${NAMESPACE}
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
  storageClassName: standard
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: agent-gravity-pvc
  namespace: ${NAMESPACE}
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 20Gi
  storageClassName: standard
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: gravity-job-agent-sa
  namespace: ${NAMESPACE}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: gravity-job-agent-rolebinding
subjects:
- kind: ServiceAccount
  name: gravity-job-agent-sa
  namespace: ${NAMESPACE}
roleRef:
  kind: ClusterRole
  name: gravity-job-agent-role
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: gravity-job-agent-role
rules:
- apiGroups: [""]
  resources: ["pods", "pods/log", "pods/exec", "services", "secrets", "configmaps", "persistentvolumeclaims", "serviceaccounts"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: [""]
  resources: ["secrets"]
  verbs: ["get", "list", "watch"]
- apiGroups: [""]
  resources: ["events"]
  verbs: ["get", "list", "watch"]
- apiGroups: [""]
  resources: ["namespaces"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: ["apps"]
  resources: ["deployments", "statefulsets", "replicasets"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: ["batch"]
  resources: ["jobs", "jobs/status"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: ["networking.k8s.io"]
  resources: ["ingresses", "networkpolicies"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: ["rbac.authorization.k8s.io"]
  resources: ["roles", "rolebindings"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: ["policy"]
  resources: ["podsecuritypolicies", "poddisruptionbudgets"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: ["argoproj.io"]
  resources: ["applications"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: [""]
  resources: ["serviceaccounts"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
---
apiVersion: v1
kind: Service
metadata:
  name: gravity-docker-registry
  namespace: ${NAMESPACE}
spec:
  selector:
    app: gravity-docker-registry
  ports:
    - port: 5000
      targetPort: 5000
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: gravity-docker-registry
  namespace: ${NAMESPACE}
spec:
  selector:
    matchLabels:
      app: gravity-docker-registry
  replicas: 1
  template:
    metadata:
      labels:
        app: gravity-docker-registry
    spec:
      containers:
        - name: registry
          image: registry:2
          ports:
            - containerPort: 5000
          volumeMounts:
            - name: gravity-docker-cache
              mountPath: /var/lib/registry
          env:
            - name: REGISTRY_STORAGE_DELETE_ENABLED
              value: "true"
          resources:
            requests:
              memory: "512Mi"
              cpu: "512m"
            limits:
              memory: "4096Mi"
              cpu: "4000m"
      volumes:
        - name: gravity-docker-cache
          persistentVolumeClaim:
            claimName: agent-gravity-pvc

```

2. Run `export $(grep -v '^#' example.env | xargs) && envsubst < deployment.yaml > deployment_subst.yaml` to generate the deployment.yaml file with the actual values.

3. Deploy the application to Kubernetes using `kubectl apply -f deployment_subst.yaml`.

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



