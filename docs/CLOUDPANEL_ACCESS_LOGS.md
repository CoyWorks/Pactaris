# Minimize Pactaris proxy access logs

Use the Pactaris access-log format on the public app and Identity vhosts. The log records timestamps, fixed request classes, methods, response status, response bytes and timings. Requests to OIDC callbacks and household APIs are grouped without recording their paths, IDs or query strings. The restricted format also omits client IP addresses, cookies, referers and user agents.

## CloudPanel configuration

1. Keep a copy of the current vhost definitions. Confirm that a server-wide include such as `/etc/nginx/conf.d/*.conf` is loaded inside NGINX's `http` context.
2. Install [pactaris-access-log.conf](../config/nginx/pactaris-access-log.conf) in that include directory. This defines a format once and leaves all other sites on their existing formats.
3. In the Pactaris and Identity vhosts, replace the current access-log directive or CloudPanel access-log placeholder with an explicit directive that keeps the site's existing path and names the format. Use the actual existing path for each vhost.

```nginx
access_log /path/to/existing/pactaris-access.log pactaris_access;
```

Inspect the rendered vhost for additional `access_log` directives in named proxy or other locations. Ensure the requests are recorded once with the intended format. Keep the current upstream CA, certificate verification and error-log settings. Run `nginx -t` before reload.

## Verify after reload

Send a harmless signed-out request with a synthetic query value. Check the site's most recent access entry for the `health` class and successful status. The query value should be absent from the access line.

```bash
curl --fail --silent --show-error 'https://pactaris.app/health/ready?pactaris_log_fixture=example'
```

Repeat against the chosen Identity site's discovery URL and check the `identity` class. Verify the [public ingress smoke checks](PUBLIC_SMOKE.md) from outside the deployment network.

Apply the existing operator access and rotation policy to both access and error logs. NGINX error entries, older logs and upstream systems can include request details. Review these before sharing them. Keep the old vhost and restore it if the syntax check or routing validation fails.

[NGINX access log formats](https://nginx.org/en/docs/http/ngx_http_log_module.html)
