# 🚀 Windows Server 2022: Node.js Dashboard Setup Guide

This document provides a streamlined, step-by-step technical configuration for deploying the Jira Dashboard on **Windows Server 2022**.

---

## 1. Disable IIS (Freeing Port 80)
Windows Server typically runs IIS or the World Wide Web Publishing Service by default. This must be disabled to allow Node.js to bind to Port 80.

**Run in PowerShell (Admin):**
```powershell
# Stop and Disable the IIS Service
Stop-Service W3SVC -Force
Set-Service W3SVC -StartupType Disabled

# Verify Port 80 is free (Should return no results)
netstat -ano | findstr :80

node -v
npm -v

# Install PM2 globally
npm install pm2 -g

# Setup PM2 to run as a Windows Service
npm install pm2-windows-startup -g
pm2-startup install

cd C:\dashboard-app
npm install

# Start the app and name the process
pm2 start app.js --name "jira-dashboard"

# Save the process list for auto-restart on reboot
pm2 save

# Create Inbound Rule for Port 80
New-NetFirewallRule -DisplayName "Allow-HTTP-80-Dashboard" -Direction Inbound -LocalPort 80 -Protocol TCP -Action Allow

pm2 start index.js --name "jira-md-export" --cron "0 0 * * *" --no-autorestart