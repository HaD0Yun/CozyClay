#!/bin/bash
# CozyClay.app's executable: opens the launcher in Terminal, where CozyClay runs until that window is closed.
exec /usr/bin/open -a Terminal "$(dirname "$0")/../Resources/CozyClay.command"
