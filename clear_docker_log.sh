#!/bin/bash

echo "Cleaning Docker container logs..."

LOG_DIR="/var/lib/docker/containers"

if [ -d "$LOG_DIR" ]; then
    find $LOG_DIR -type f -name "*-json.log" -exec truncate -s 0 {} \;
    echo "All Docker logs cleaned."
else
    echo "Docker log directory not found."
fi