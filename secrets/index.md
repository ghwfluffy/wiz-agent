# Secrets Directory

Production secrets (passwords, API keys) are kept in this directory. Below are the expected files and examples to show the fields.

## email.json

IMAP and SMTP information for agent's email account.

```json
{
  "username": "agent@example.com",
  "imap": {
    "host": "imap.example.com",
    "port": 993
  },
  "smtp": {
    "host": "smtp.example.com",
    "port": 465,
    "mode": "smtps",
    "from": "Robot <agent@example.com>"
  }
}
```

### SMTP Modes

* clear: No encryption
* smtps: Implicit TLS
* STARTTLS: Starts plaintext, upgrades to TLS

## contact.json

How to contact the operator.

```json
{
  "name": "Itsame Mario",
  "mobile": "5551234567",
  "mobileProvider": "Mint Mobile",
  "smsGateway": "5551234567@mailmymobile.net",
  "mmsGateway": "5551234567@mailmymobile.net",
  "email": "me@example.com"
}
```

## git.json

Git repository and author information for persisting agent changes. Provision a deploy key with write access to the repository.

```
{
  "repository": "git@github.com/myuser/agent.git",
  "branch": "master",
  "apiKey": "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\nQyNTUxOQAAACDwG1AuRXlD8AW3M1rMi+IpRVI/GWAzQlxc+ajy6UyJvwAAAJjwZ/DG8Gfw\nxgAAAAtzc2gtZWQyNTUxOQAAACDwG1AuRXlD8AW3M1rMi+IpRVI/GWAzQlxc+ajy6UyJvw\nAAAEA0noHlTIYtCbcRu2pSROiLVMa6b6hox8xY3nAIPwvd0PAbUC5FeUPwBbczWsyL4ilF\nUj8ZYDNCXFz5qPLpTIm/AAAAE3RmdWxsZXJAdWJ1bnR1LTI0MDQBAg==\n-----END OPENSSH PRIVATE KEY-----",
  "user.email": "agent@example.com",
  "user.name": "Robot"
}
```
