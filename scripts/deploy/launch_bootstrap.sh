#!/usr/bin/env bash
set -e
mkdir -p /root/autodl-tmp/adg/logs
tr -d '\r' < /root/autodl-tmp/bootstrap.sh > /root/autodl-tmp/b2.sh
mv /root/autodl-tmp/b2.sh /root/autodl-tmp/bootstrap.sh
chmod +x /root/autodl-tmp/bootstrap.sh
tmux new-session -d -s bootstrap 'bash /root/autodl-tmp/bootstrap.sh &> /root/autodl-tmp/adg/logs/bootstrap.log'
echo TMUX_STARTED
