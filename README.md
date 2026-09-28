# dashboard

## Run the dashboard server

The dashboard uses a same-origin API for shared state. Serve it with the included Node.js server instead of opening `index.html` directly or deploying it as a static-only site. Node.js 18 or newer is required.

```sh
DASHBOARD_USER=teacher DASHBOARD_PASSWORD='choose-a-long-password' node server.js
```

Open `http://localhost:3000`. The browser will ask for the shared username and password; use the same credentials on each browser or device. For a deployed site, put the server behind HTTPS and set these credentials as deployment secrets, not in source control.

The API serves `GET /api/state`, accepts revision-checked `PUT /api/state` requests, and broadcasts successful changes through `GET /api/events`. State is stored in `data/state.json` by default. Set `DATA_DIR` to a persistent disk or mounted volume in production; ephemeral container filesystems do not survive redeployment. Run one server instance with this file-backed store. Multiple server replicas require a shared transactional database instead.

If the server is unavailable, the page reports the synchronization error and does not send local defaults to the server. A stale write is rejected and the latest server copy is loaded rather than replaced.