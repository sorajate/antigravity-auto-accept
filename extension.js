const vscode = require('vscode');
const http = require('http');

let autoAcceptInterval = null;
let enabled = true;
let autoRetryEnabled = true;
let cdpPort = 9222;
let retryMaxCount = 10;
let retryCurrentCount = 0;
let statusBarItem;
let retryStatusBarItem;
let lastRetryAttempt = 0;
let outputChannel;
let cdpConnected = false; // Track if the port is actually open
let isInternalExecuting = false; // Flag to prevent command spy from logging our own loop


function activate(context) {
    console.log('[Antigravity Auto-Accept 🚀] Plugin is ACTIVATING...');

    // Create output channel for logging
    outputChannel = vscode.window.createOutputChannel('Antigravity Auto-Accept');
    context.subscriptions.push(outputChannel);

    // Watch for settings changes...
    hookVSCodeCommands(); // Start the smart spy
    // listAllInterestingCommands(); // Discover all available commands



    // Load settings
    loadSettings();

    // Watch for settings changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('antigravity-auto-accept')) {
                loadSettings();
                updateRetryStatusBar();
            }
        })
    );

    // Register toggle command for auto-accept
    let disposable = vscode.commands.registerCommand('unlimited.toggle', function () {
        enabled = !enabled;
        updateStatusBar();
        if (enabled) {
            vscode.window.showInformationMessage('Auto-Accept: ON ✅');
        } else {
            vscode.window.showInformationMessage('Auto-Accept: OFF 🛑');
        }
    });
    context.subscriptions.push(disposable);

    // Register toggle command for auto-retry (CDP)
    let toggleRetry = vscode.commands.registerCommand('unlimited.toggleRetry', function () {
        autoRetryEnabled = !autoRetryEnabled;
        // Save to settings
        vscode.workspace.getConfiguration('antigravity-auto-accept').update('autoRetryEnabled', autoRetryEnabled, true);
        updateRetryStatusBar();
        if (autoRetryEnabled) {
            vscode.window.showInformationMessage(`Auto-Retry (CDP): ON ✅ Port: ${cdpPort}`);
        } else {
            vscode.window.showInformationMessage('Auto-Retry (CDP): OFF 🛑');
        }
    });
    context.subscriptions.push(toggleRetry);

    // Register set CDP port command
    let setCdpPort = vscode.commands.registerCommand('unlimited.setCdpPort', async function () {
        const input = await vscode.window.showInputBox({
            prompt: 'Enter CDP port (e.g., 9222)',
            value: cdpPort.toString(),
            validateInput: (value) => {
                const port = parseInt(value);
                if (isNaN(port) || port < 1 || port > 65535) {
                    return 'Please enter a valid port number (1-65535)';
                }
                return null;
            }
        });
        if (input) {
            cdpPort = parseInt(input);
            vscode.workspace.getConfiguration('antigravity-auto-accept').update('cdpPort', cdpPort, true);
            vscode.window.showInformationMessage(`CDP Port set to: ${cdpPort}`);
            updateRetryStatusBar();
        }
    });
    context.subscriptions.push(setCdpPort);

    // Register set retry max count command
    let setRetryMaxCount = vscode.commands.registerCommand('unlimited.setRetryMaxCount', async function () {
        const input = await vscode.window.showInputBox({
            prompt: 'Enter maximum retry attempts (0 = unlimited)',
            value: retryMaxCount.toString(),
            validateInput: (value) => {
                const count = parseInt(value);
                if (isNaN(count) || count < 0) {
                    return 'Please enter a valid number (0 or greater)';
                }
                return null;
            }
        });
        if (input) {
            retryMaxCount = parseInt(input);
            retryCurrentCount = 0; // Reset counter when changing max
            vscode.workspace.getConfiguration('antigravity-auto-accept').update('retryMaxCount', retryMaxCount, true);
            vscode.window.showInformationMessage(`Retry max count set to: ${retryMaxCount === 0 ? 'Unlimited' : retryMaxCount}`);
            updateRetryStatusBar();
        }
    });
    context.subscriptions.push(setRetryMaxCount);

    // Register reset retry counter command
    let resetRetryCount = vscode.commands.registerCommand('unlimited.resetRetryCount', function () {
        retryCurrentCount = 0;
        vscode.window.showInformationMessage('Retry counter reset to 0');
        updateRetryStatusBar();
    });
    context.subscriptions.push(resetRetryCount);

    // Debug command to list all antigravity commands
    let listCommands = vscode.commands.registerCommand('unlimited.listCommands', async function () {
        const allCommands = await vscode.commands.getCommands(true);
        const antigravityCommands = allCommands.filter(cmd =>
            cmd.toLowerCase().includes('antigravity') ||
            cmd.toLowerCase().includes('agent') ||
            cmd.toLowerCase().includes('retry') ||
            cmd.toLowerCase().includes('allow') ||
            cmd.toLowerCase().includes('confirm') ||
            cmd.toLowerCase().includes('cockpit')
        );

        const outputChannel = vscode.window.createOutputChannel('Antigravity Commands');
        outputChannel.clear();
        outputChannel.appendLine('=== Antigravity Related Commands ===\n');
        antigravityCommands.sort().forEach(cmd => {
            outputChannel.appendLine(cmd);
        });
        outputChannel.show();

        vscode.window.showInformationMessage(`Found ${antigravityCommands.length} related commands. Check Output panel.`);
    });
    context.subscriptions.push(listCommands);

    try {
        // Create Auto-Accept status bar item
        statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10000);
        statusBarItem.command = 'unlimited.toggle';
        context.subscriptions.push(statusBarItem);

        // Create Auto-Retry status bar item
        retryStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 9999);
        retryStatusBarItem.command = 'unlimited.toggleRetry';
        context.subscriptions.push(retryStatusBarItem);

        updateStatusBar();
        updateRetryStatusBar();
        statusBarItem.show();
        retryStatusBarItem.show();
    } catch (e) {
        // Silent failure
    }

    // Start the loop
    startLoop();
    console.log('[Antigravity Auto-Accept 🚀] Plugin ACTIVATED and Loop started!');
}

function loadSettings() {
    const config = vscode.workspace.getConfiguration('antigravity-auto-accept');
    cdpPort = config.get('cdpPort', 9222);
    autoRetryEnabled = config.get('autoRetryEnabled', true);
    retryMaxCount = config.get('retryMaxCount', 10);
}

/**
 * Smart Spy: Intercepts commands but ignores our own automated calls
 */
function hookVSCodeCommands() {
    const originalExecute = vscode.commands.executeCommand;
    vscode.commands.executeCommand = function (command, ...args) {
        // Only log if it's NOT our internal loop and it's a related command
        if (!isInternalExecuting) {
            const cmdLower = command.toLowerCase();
            const isInteresting = cmdLower.includes('antigravity') || cmdLower.includes('agent') || cmdLower.includes('cockpit');

            if (isInteresting && outputChannel) {
                outputChannel.appendLine(`[SPY] SYSTEM Triggered: ${command}`);
                console.log(`[Antigravity Auto-Accept 🚀] [SPY] Intercepted external call: ${command}`);
            }
        }
        return originalExecute.apply(this, [command, ...args]);
    };
}

/**
 * ดึงรายชื่อคำสั่งทั้งหมดที่มีอยู่จริงใน VS Code (ทุกปลั๊กอิน) ออกมาตรวจสอบ
 */
async function listAllInterestingCommands() {
    try {
        const allCommands = await vscode.commands.getCommands(true);

        // กรองคำสั่งที่ไม่ใช่ของ VS Code เอง
        const pluginCommands = allCommands.filter(cmd =>
            !cmd.startsWith('vscode.') &&
            !cmd.startsWith('unlimited.')
        ).sort();

        if (outputChannel) {
            outputChannel.appendLine(`\n====================================================`);
            outputChannel.appendLine(`🔎 COMMAND DISCOVERY REPORT (Found: ${allCommands.length} total)`);
            outputChannel.appendLine(`====================================================`);

            outputChannel.appendLine(`\n[!] NON-VSCODE COMMANDS (${pluginCommands.length}):`);
            pluginCommands.forEach(cmd => {
                // เน้นสีคำที่น่าจะเกี่ยวกับเรา
                const isVeryInteresting = ['agent', 'anti', 'gravity', 'accept', 'allow', 'confirm', 'step', 'cockpit'].some(w => cmd.toLowerCase().includes(w));
                const prefix = isVeryInteresting ? ' ⭐ ' : '  - ';
                outputChannel.appendLine(`${prefix}${cmd}`);
            });

            outputChannel.appendLine(`\n====================================================\n`);
        }

        console.log(`[Antigravity Auto-Accept 🚀] Discovery finished. Found ${pluginCommands.length} plugin commands.`);
    } catch (e) {
        console.error('Failed to list commands', e);
    }
}



function updateStatusBar() {
    if (!statusBarItem) return;

    if (enabled) {
        statusBarItem.text = "✅ Auto-Accept: ON";
        statusBarItem.tooltip = "Unlimited Auto-Accept is Executing (Click to Pause)";
        statusBarItem.backgroundColor = undefined;
    } else {
        statusBarItem.text = "🛑 Auto-Accept: OFF";
        statusBarItem.tooltip = "Unlimited Auto-Accept is Paused (Click to Resume)";
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
}

function updateRetryStatusBar() {
    if (!retryStatusBarItem) return;

    if (autoRetryEnabled) {
        const countInfo = retryMaxCount === 0 ? '∞' : `${retryCurrentCount}/${retryMaxCount}`;

        let statusPrefix = cdpConnected ? '✅' : '⚠️';
        let tooltipWarning = cdpConnected ? '' : `\n\n⚠️ CDP WARNING: Port ${cdpPort} appears closed or unreachable!\nMake sure VS Code was started with --remote-debugging-port=${cdpPort}`;

        retryStatusBarItem.text = `${statusPrefix} Auto-Retry: ON (${cdpPort}) [${countInfo}]`;
        retryStatusBarItem.tooltip = `Auto-Retry via CDP is Enabled\nPort: ${cdpPort}\nRetry Count: ${countInfo}${tooltipWarning}\nClick to Disable`;

        // Show warning if disconnected or approaching limit
        if (!cdpConnected) {
            retryStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else if (retryMaxCount > 0 && retryCurrentCount >= retryMaxCount) {
            retryStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        } else {
            retryStatusBarItem.backgroundColor = undefined;
        }
    } else {
        retryStatusBarItem.text = "🛑 Auto-Retry: OFF";
        retryStatusBarItem.tooltip = "Auto-Retry via CDP is Disabled (Click to Enable)";
        retryStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
}

// ========== CDP Functions ==========

/**
 * Get list of CDP targets
 */
function getCDPTargets() {
    return new Promise((resolve, reject) => {
        const req = http.get(`http://localhost:${cdpPort}/json`, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(1000, () => {
            req.destroy();
            reject(new Error('Timeout'));
        });
    });
}

/**
 * Send CDP command via HTTP (simpler than WebSocket for one-off commands)
 */
function sendCDPCommand(targetId, method, params = {}) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
            id: Date.now(),
            method: method,
            params: params
        });

        const req = http.request({
            hostname: 'localhost',
            port: cdpPort,
            path: `/json/protocol`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        });

        req.on('error', reject);
        req.setTimeout(2000, () => {
            req.destroy();
            reject(new Error('Timeout'));
        });
        req.write(postData);
        req.end();
    });
}

/**
 * Execute JavaScript in a target via CDP WebSocket
 */
function executeScriptInTarget(wsUrl, script) {
    return new Promise((resolve, reject) => {
        // Use native WebSocket-like approach with http upgrade
        // For simplicity, we'll use a different approach: 
        // Fetch API is not available in Node, so we use http raw request

        const url = new URL(wsUrl);
        const WebSocket = require('ws');

        try {
            const ws = new WebSocket(wsUrl);
            let resolved = false;

            ws.on('open', () => {
                ws.send(JSON.stringify({
                    id: 1,
                    method: 'Runtime.evaluate',
                    params: {
                        expression: script,
                        returnByValue: true
                    }
                }));
            });

            ws.on('message', (data) => {
                if (!resolved) {
                    resolved = true;
                    try {
                        const response = JSON.parse(data.toString());
                        resolve(response);
                    } catch (e) {
                        resolve(null);
                    }
                    ws.close();
                }
            });

            ws.on('error', (err) => {
                if (!resolved) {
                    resolved = true;
                    reject(err);
                }
            });

            // Timeout
            setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    ws.close();
                    reject(new Error('WebSocket timeout'));
                }
            }, 3000);
        } catch (e) {
            reject(e);
        }
    });
}

/**
 * Click the Retry button via CDP
 */
let retryLimitDialogShown = false; // Flag to prevent multiple dialogs

async function clickRetryViaCDP() {
    // Check if max retry count reached (0 = unlimited)
    if (retryMaxCount > 0 && retryCurrentCount >= retryMaxCount) {
        // Show confirmation dialog only once
        if (!retryLimitDialogShown) {
            retryLimitDialogShown = true;
            const timestamp = new Date().toLocaleTimeString();
            outputChannel.appendLine(`[${timestamp}] ⚠️ Retry limit reached (${retryMaxCount}). Waiting for user confirmation...`);

            const result = await vscode.window.showWarningMessage(
                `Auto-Retry has reached the limit of ${retryMaxCount} attempts. Continue auto-retry?`,
                { modal: false },
                'Continue',
                'Stop Auto-Retry'
            );

            if (result === 'Continue') {
                retryCurrentCount = 0;
                retryLimitDialogShown = false;
                updateRetryStatusBar();
                outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ✅ User confirmed. Retry counter reset. Auto-retry will continue.`);
            } else {
                // User chose to stop or dismissed dialog
                autoRetryEnabled = false;
                retryLimitDialogShown = false;
                updateRetryStatusBar();
                outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] 🛑 Auto-retry disabled by user.`);
                vscode.window.showInformationMessage('Auto-Retry has been disabled. Use the status bar to re-enable.');
            }
        }
        return; // Don't retry until user confirms
    }

    // Debounce: prevent rapid retry attempts
    const now = Date.now();
    if (now - lastRetryAttempt < 2000) {
        return;
    }
    lastRetryAttempt = now;

    try {
        const targets = await getCDPTargets();

        if (!cdpConnected) {
            cdpConnected = true;
            updateRetryStatusBar();
            outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] 🔌 CDP Connection Established/Restored on port ${cdpPort}`);
        }

        // Broad first pass: any page or webview that could be the agent panel
        const potentialTargets = targets.filter(t =>
            t.type === 'page' || t.type === 'webview' ||
            (t.title && (
                t.title.includes('Antigravity') ||
                t.title.includes('Agent') ||
                t.title.includes('Chat')
            )) ||
            (t.url && (
                t.url.includes('workbench') ||
                t.url.includes('webview')
            ))
        );

        if (potentialTargets.length > 0) {
            //outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] [DETECTION] Found ${potentialTargets.length} potential Antigravity windows. Scanning for dialogs...`);
            //console.log(`[Antigravity Auto-Accept 🚀] [DETECTION] Found ${potentialTargets.length} potential Antigravity windows. Scanning for dialogs...`);
        }

        // JavaScript to find and click Retry button (including inside iframes)
        const clickRetryScript = `
            (function() {
                // Helper function to find and click action buttons in a document
                function findAndClickAction(doc, location) {
                    try {
                        // Strictly require #conversation container - no ID, no action.
                        const conversation = doc.getElementById('conversation') || doc.querySelector('[id^="conversation-"]');
                        if (!conversation) return null;
                        
                        const searchRoot = conversation;
                        
                        const buttons = searchRoot.querySelectorAll('button');
                        const targets = ['Retry', 'Run', 'Accept', 'Allow', 'Confirm', 'Yes', 'Continue', 'Approve'];
                        
                        for (const btn of buttons) {
                            if (btn.disabled || btn.offsetParent === null) continue;
                            
                            const text = btn.textContent ? btn.textContent.trim().toLowerCase() : '';
                            
                            // Check for various action words
                            const matched = targets.find(t => {
                                const targetLow = t.toLowerCase();
                                // Match if exact, or starts with target followed by space/shortcut
                                return text === targetLow || 
                                       text.startsWith(targetLow + ' ') || 
                                       text.startsWith(targetLow + '\\n') ||
                                       text.startsWith(targetLow + 'alt') ||
                                       text.startsWith(targetLow + 'ctrl');
                            });

                            if (matched) {
                                btn.click();
                                const convoId = conversation ? conversation.id : 'conversation';
                                return 'clicked_' + location + '_' + matched + '_' + convoId;
                            }
                        }
                    } catch (e) {
                        return null;
                    }
                    return null;
                }
                
                // Try main document first
                let result = findAndClickAction(document, 'main');
                if (result) return result;
                
                // Try all iframes (where Antigravity Agent panel lives)
                const iframes = document.querySelectorAll('iframe');
                for (let i = 0; i < iframes.length; i++) {
                    try {
                        const iframe = iframes[i];
                        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                        if (iframeDoc) {
                            result = findAndClickAction(iframeDoc, 'iframe_' + i);
                            if (result) return result;
                        }
                    } catch (e) {
                        // Cross-origin iframe, skip
                    }
                }
                
                return 'not_found';
            })();
        `;

        // Second pass: check each target for #conversation before attempting clicks
        const hasConversationScript = `(function() { return !!(document.getElementById('conversation') || document.querySelector('[id^="conversation-"]')); })();`;

        for (const target of potentialTargets) {
            if (target.webSocketDebuggerUrl) {
                try {
                    // Gate: skip this target if it has no #conversation element
                    const checkResult = await executeScriptInTarget(target.webSocketDebuggerUrl, hasConversationScript);
                    const hasConvo = checkResult?.result?.result?.value || checkResult?.result?.value;
                    if (!hasConvo) continue;

                    const result = await executeScriptInTarget(target.webSocketDebuggerUrl, clickRetryScript);
                    // CDP returns nested structure: result.result.result.value
                    const value = result?.result?.result?.value || result?.result?.value;
                    if (value && typeof value === 'string' && value.startsWith('clicked_')) {
                        retryCurrentCount++;
                        const timestamp = new Date().toLocaleTimeString();

                        const parts = value.split('_');
                        const location = parts[1];
                        const action = parts[2] || 'Action';
                        const convoId = parts[3] || 'unknown';

                        const countInfo = retryMaxCount === 0 ? retryCurrentCount : `${retryCurrentCount}/${retryMaxCount}`;
                        outputChannel.appendLine(`[${timestamp}] ✅ ${action} #${countInfo} clicked via CDP (target: ${target.title || target.url}, location: ${location}, convo: ${convoId})`);
                        outputChannel.show(true);  // Show output channel, preserve focus
                        updateRetryStatusBar(); // Update status bar with new count
                        return;
                    }
                } catch (e) {
                    // Target not accessible, continue to next
                }
            }
        }
    } catch (e) {
        // CDP not available or error, silent fail
        if (cdpConnected) {
            cdpConnected = false;
            updateRetryStatusBar();
            outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ❌ CDP Connection Failed on port ${cdpPort}. Is VS Code started with --remote-debugging-port?`);
        }
    }
}

function startLoop() {
    autoAcceptInterval = setInterval(async () => {
        if (!enabled) return;

        // Set flag to true so our spy doesn't log these
        isInternalExecuting = true;

        try {
            // ========== AUTO-ACCEPT AGENT STEPS ==========
            await vscode.commands.executeCommand('antigravity.agent.acceptAgentStep').catch(() => { });

            // ========== AUTO-ACCEPT TERMINAL COMMANDS ==========
            await vscode.commands.executeCommand('antigravity.terminal.accept').catch(() => { });
            await vscode.commands.executeCommand('antigravity.terminalCommand.accept').catch(() => { });
            await vscode.commands.executeCommand('antigravity.command.accept').catch(() => { });

            // ========== AUTO-CONFIRM STEP EXECUTION ==========
            await vscode.commands.executeCommand('antigravity.agent.confirmStep').catch(() => { });
            await vscode.commands.executeCommand('agCockpit.confirm').catch(() => { });
            await vscode.commands.executeCommand('antigravity.confirm').catch(() => { });

            // ========== AUTO-ALLOW PERMISSIONS ==========
            await vscode.commands.executeCommand('antigravity.agent.allowOnce').catch(() => { });
            await vscode.commands.executeCommand('antigravity.agent.allowConversation').catch(() => { });
            await vscode.commands.executeCommand('agCockpit.allowOnce').catch(() => { });
            await vscode.commands.executeCommand('agCockpit.allowConversation').catch(() => { });
            await vscode.commands.executeCommand('antigravity.allow').catch(() => { });

            // ========== AUTO-RETRY VIA CDP ==========
            if (autoRetryEnabled) {
                await clickRetryViaCDP();
            }
        } finally {
            // Unset flag after all commands finished
            isInternalExecuting = false;
        }
    }, 500);
}


function deactivate() {
    if (autoAcceptInterval) {
        clearInterval(autoAcceptInterval);
    }
}

module.exports = {
    activate,
    deactivate
}
