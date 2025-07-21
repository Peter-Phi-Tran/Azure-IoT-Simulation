'use strict';

const { ProvisioningDeviceClient } = require('azure-iot-provisioning-device'); 
const { Mqtt: ProvisioningMqtt } = require('azure-iot-provisioning-device-mqtt');
const { SymmetricKeySecurityClient } = require('azure-iot-security-symmetric-key');
const { Client, Message } = require('azure-iot-device');
const { Mqtt: DeviceMqtt } = require('azure-iot-device-mqtt');
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Load configuration
const config = require('./config.json');

// Extract configuration values
const {
  numberOfDevices,
  telemetryInterval,
  firmwareCheckInterval,
  batchSize,
  batchDelay,
  deviceStaggerDelay
} = config.simulation;

const {
  firmwareVersion,
  hardwareVersion,
  deviceModel,
  deviceIdPrefix
} = config.device;

const {
  idScope,
  groupEnrollmentKey,
  provisioningEndpoint
} = config.dps;

const {
  statsInterval,
  telemetryLogFrequency,
  enableDetailedLogging,
  showShutdownCountdown
} = config.logging;

// Timer configuration
const runDurationMinutes = config.simulation.runDurationMinutes || 12;
const autoShutdown = config.simulation.autoShutdown || false;

// Timer variables
let startTime = Date.now();
let shutdownTimer;
let countdownInterval;

// Timer functions
function startSimulationTimer() {
  if (!autoShutdown) {
    console.log('Auto-shutdown disabled in config');
    return;
  }
  
  const runDurationMs = runDurationMinutes * 60 * 1000;
  console.log(`Starting ${runDurationMinutes}-minute simulation timer`);
  console.log(`Simulation will end at: ${new Date(Date.now() + runDurationMs).toLocaleTimeString()}`);
  
  // Countdown display
  if (showShutdownCountdown) {
    countdownInterval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, runDurationMs - elapsed);
      const remainingMinutes = Math.ceil(remaining / 60000);
      
      if (remainingMinutes > 0) {
        console.log(`Time remaining: ${remainingMinutes} minute(s)`);
      }
    }, 60000); // Every minute
  }
  
  // Auto-shutdown timer
  shutdownTimer = setTimeout(() => {
    console.log('\nSimulation timer expired - initiating shutdown...');
    gracefulShutdown('Timer expired');
  }, runDurationMs);
}

function gracefulShutdown(reason = 'Manual shutdown') {
  console.log(`\nShutting down MQTT simulation: ${reason}`);
  
  // Clear timers
  if (shutdownTimer) clearTimeout(shutdownTimer);
  if (countdownInterval) clearInterval(countdownInterval);
  
  // Generate final statistics
  const endTime = Date.now();
  const actualRuntime = (endTime - startTime) / 1000 / 60; // minutes
  
  console.log('\n=== FINAL SIMULATION REPORT ===');
  console.log(`Start Time: ${new Date(startTime).toLocaleTimeString()}`);
  console.log(`End Time: ${new Date(endTime).toLocaleTimeString()}`);
  console.log(`Actual Runtime: ${actualRuntime.toFixed(2)} minutes`);
  console.log(`Planned Runtime: ${runDurationMinutes} minutes`);
  
  // Get final stats if available
  if (typeof getStats === 'function') {
    console.log('\n=== FINAL STATISTICS ===');
    getStats();
  }
  
  // Close all device connections
  console.log('Closing MQTT device connections...');
  
  const shutdownPromises = [];
  
  // Close all device clients
  if (typeof devices !== 'undefined' && devices.length > 0) {
    devices.forEach(device => {
      if (device && device.client && typeof device.client.close === 'function') {
        shutdownPromises.push(
          new Promise((resolve) => {
            console.log(`[${device.deviceId}] Closing connection...`);
            device.client.close(() => {
              console.log(`[${device.deviceId}] Connection closed`);
              resolve();
            });
          })
        );
      }
    });
  }
  
  Promise.allSettled(shutdownPromises).then(() => {
    console.log('All MQTT connections closed');
    console.log('Simulation completed successfully');
    process.exit(0);
  });
  
  // Force exit after 10 seconds if graceful shutdown fails
  setTimeout(() => {
    console.log(' Force exit after 10 seconds');
    process.exit(1);
  }, 10000);
}

// Global timer control functions
global.getRemainingTime = () => {
  const elapsed = Date.now() - startTime;
  const remaining = Math.max(0, (runDurationMinutes * 60 * 1000) - elapsed);
  return Math.ceil(remaining / 60000); // minutes
};

global.extendTimer = (additionalMinutes) => {
  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
    const additionalMs = additionalMinutes * 60 * 1000;
    const remainingMs = (runDurationMinutes * 60 * 1000) - (Date.now() - startTime);
    const newDurationMs = remainingMs + additionalMs;
    
    shutdownTimer = setTimeout(() => {
      gracefulShutdown('Extended timer expired');
    }, newDurationMs);
    console.log(`Timer extended by ${additionalMinutes} minutes`);
  }
};

global.stopTimer = () => gracefulShutdown('Manual timer stop');

// Function to derive device key from group enrollment key
function deriveDeviceKey(groupKey, deviceId) {
  const hmac = crypto.createHmac('sha256', Buffer.from(groupKey, 'base64'));
  hmac.update(deviceId);
  return hmac.digest('base64');
}

// Create a device simulator function
async function createDeviceSimulator(deviceIndex) {
  const deviceId = `${deviceIdPrefix}-${deviceIndex.toString().padStart(3, '0')}`;
  let currentFirmwareVersion = firmwareVersion;
  let client;
  let telemetryCount = 0;
  let errorCount = 0;
  let isConnected = false;
  let twin = null;

  function log(message) {
    if (enableDetailedLogging) {
      console.log(`[${deviceId}] ${message}`);
    }
  }

  function logError(message) {
    console.error(`[${deviceId}] ${message}`);
    errorCount++;
  }

  function logInfo(message) {
    console.log(`[${deviceId}] ${message}`);
  }

  // Handle device twin desired properties (for firmware updates)
  function handleDeviceTwin(twin) {
    log('Device twin received');
    
    // Handle initial desired properties
    if (twin.properties.desired.firmwareUpdate) {
      handleFirmwareUpdateFromTwin(twin.properties.desired.firmwareUpdate);
    }

    // Handle desired property updates
    twin.on('properties.desired', (desiredChange) => {
      log('Desired properties changed: ' + JSON.stringify(desiredChange));
      
      if (desiredChange.firmwareUpdate) {
        handleFirmwareUpdateFromTwin(desiredChange.firmwareUpdate);
      }
    });
  }

  // Handle firmware update from device twin
  async function handleFirmwareUpdateFromTwin(firmwareUpdate) {
    const { version, url } = firmwareUpdate;
    
    if (!version || !url) {
      logError('Invalid firmware update request - missing version or url');
      return;
    }

    if (version === currentFirmwareVersion) {
      logInfo(`Already running firmware version ${version}`);
      reportFirmwareStatus('current', version);
      return;
    }

    logInfo(`Firmware update requested via Device Twin: ${currentFirmwareVersion} -> ${version}`);
    await handleOTAUpdate({ version, url });
  }

  // Report firmware status via device twin reported properties
  function reportFirmwareStatus(status, targetVersion = null, error = null) {
    if (!twin) {
      logError('Cannot report firmware status - no device twin available');
      return;
    }

    const reportedProperties = {
      firmwareStatus: {
        currentVersion: currentFirmwareVersion,
        status: status,
        timestamp: new Date().toISOString()
      }
    };

    if (targetVersion) reportedProperties.firmwareStatus.targetVersion = targetVersion;
    if (error) reportedProperties.firmwareStatus.error = error;

    twin.properties.reported.update(reportedProperties, (err) => {
      if (err) {
        logError(`Failed to report firmware status: ${err.toString()}`);
      } else {
        logInfo(`Firmware status reported: ${status}`);
      }
    });
  }

  // Download firmware from blob storage
  function downloadFirmware(url, filePath) {
    return new Promise((resolve, reject) => {
      logInfo(`Downloading firmware from: ${url}`);
      
      const file = fs.createWriteStream(filePath);
      const request = https.get(url, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`Download failed with status: ${response.statusCode}`));
          return;
        }

        response.pipe(file);
        
        file.on('finish', () => {
          file.close();
          logInfo('Firmware download completed');
          resolve();
        });
      });

      request.on('error', (err) => {
        fs.unlink(filePath, () => {});
        reject(err);
      });

      file.on('error', (err) => {
        fs.unlink(filePath, () => {});
        reject(err);
      });
    });
  }

  // Simulate firmware installation
  async function installFirmware(filePath, targetVersion) {
    logInfo(`Installing firmware version ${targetVersion}...`);
    
    // Simulate installation time
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    currentFirmwareVersion = targetVersion;
    logInfo(`Firmware updated to version ${currentFirmwareVersion}`);
    
    // Clean up downloaded file
    try {
      fs.unlinkSync(filePath);
      log('Firmware file cleaned up');
    } catch (err) {
      logError(`Could not clean up firmware file: ${err.message}`);
    }
  }

  // Handle OTA update process
  async function handleOTAUpdate(updateInfo) {
    const { version, url } = updateInfo;
    
    if (version === currentFirmwareVersion) {
      logInfo(`Already running firmware version ${version}`);
      reportFirmwareStatus('current', version);
      return;
    }

    logInfo(`OTA Update requested: ${currentFirmwareVersion} -> ${version}`);
    
    reportFirmwareStatus('downloading', version);

    try {
      const firmwarePath = path.join(__dirname, `firmware_${deviceId}_${version}.bin`);
      await downloadFirmware(url, firmwarePath);
      
      reportFirmwareStatus('installing', version);
      await installFirmware(firmwarePath, version);
      
      reportFirmwareStatus('completed', version);
      logInfo('OTA update completed successfully');

    } catch (error) {
      logError(`OTA update failed: ${error}`);
      reportFirmwareStatus('failed', version, error.message);
    }
  }

  // Handle direct methods (cloud-to-device commands)
  function setupDirectMethods() {
    // Firmware update method
    client.onDeviceMethod('firmwareUpdate', async (request, response) => {
      logInfo('Firmware update method called');
      
      const { version, url } = request.payload;
      
      if (!version || !url) {
        const errorMsg = 'Invalid firmware update request - missing version or url';
        logError(errorMsg);
        response.send(400, { error: errorMsg });
        return;
      }

      response.send(200, { message: 'Firmware update initiated' });
      
      // Handle the update asynchronously
      await handleOTAUpdate({ version, url });
    });

    // Reboot method
    client.onDeviceMethod('reboot', (request, response) => {
      logInfo('Reboot method called');
      response.send(200, { message: 'Reboot initiated' });
      
      // Simulate reboot
      setTimeout(() => {
        logInfo('Device rebooted');
        sendTelemetry(); // Send telemetry after reboot
      }, 2000);
    });

    // Get device info method
    client.onDeviceMethod('getDeviceInfo', (request, response) => {
      const deviceInfo = {
        deviceId: deviceId,
        firmwareVersion: currentFirmwareVersion,
        hardwareVersion: hardwareVersion,
        deviceModel: deviceModel,
        lastBoot: new Date().toISOString(),
        transport: 'MQTT',
        telemetryCount: telemetryCount,
        errorCount: errorCount,
        isConnected: isConnected
      };

      response.send(200, deviceInfo);
    });
  }

  // Telemetry functions
  function getRandomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function generateTelemetry() {
    return {
      messageType: 'telemetry',
      temperature: getRandomInt(30, 45),
      uvIndex: getRandomInt(1, 12),
      sessionTime: getRandomInt(0, 20),
      humidity: getRandomInt(20, 60),
      boothDoorOpen: Math.random() > 0.95,
      deviceId: deviceId,
      firmwareVersion: currentFirmwareVersion,
      timestamp: new Date().toISOString()
    };
  }

  function sendTelemetry() { 
    if (!isConnected) return;

    const data = generateTelemetry();
    const message = new Message(JSON.stringify(data));
    
    message.properties.add('messageType', 'telemetry');
    message.properties.add('deviceType', deviceModel);
    message.properties.add('enrollmentType', 'group');
    message.properties.add('firmwareVersion', currentFirmwareVersion);
    
    client.sendEvent(message, (err) => {
      if (err) {
        logError(`Failed to send message: ${err.toString()}`);
      } else {
        telemetryCount++;
        // Reduce logging noise
        if (Math.random() < telemetryLogFrequency) {
          logInfo(`Telemetry sent successfully (count: ${telemetryCount})`);
        }
      }
    });
  }

  // Main device logic
  try {
    logInfo(`Starting device simulation - Firmware v${currentFirmwareVersion}`);
    
    const deviceKey = deriveDeviceKey(groupEnrollmentKey, deviceId);
    const securityClient = new SymmetricKeySecurityClient(deviceId, deviceKey);
    
    // Create provisioning client using MQTT
    const provisioningClient = ProvisioningDeviceClient.create(
      provisioningEndpoint,
      idScope,
      new ProvisioningMqtt(),
      securityClient
    );

    logInfo('Registering device with group enrollment...');
    
    const result = await new Promise((resolve, reject) => {
      provisioningClient.register((err, deviceResult) => {
        if (err) {
          logError(`Registration failed: ${err}`);
          reject(err);
          return;
        }
        resolve(deviceResult);
      });
    });
    
    logInfo(`Registration succeeded - Hub: ${result.assignedHub}`);

    const deviceConnectionString = `HostName=${result.assignedHub};DeviceId=${result.deviceId};SharedAccessKey=${deviceKey}`;
    
    // Create device client using MQTT
    client = Client.fromConnectionString(deviceConnectionString, DeviceMqtt);

    // Set up connection event handlers
    client.on('connect', () => {
      logInfo('Connected to IoT Hub via MQTT');
      isConnected = true;
    });

    client.on('disconnect', () => {
      logError('Disconnected from IoT Hub');
      isConnected = false;
    });

    client.on('error', (err) => {
      logError(`Client error: ${err.toString()}`);
    });

    // Open connection
    await new Promise((resolve, reject) => {
      client.open((err) => {
        if (err) {
          logError(`Could not connect: ${err.message}`);
          reject(err);
          return;
        }
        resolve();
      });
    });

    // Get device twin
    client.getTwin((err, twinInstance) => {
      if (err) {
        logError(`Could not get device twin: ${err.toString()}`);
      } else {
        twin = twinInstance;
        handleDeviceTwin(twin);
        
        // Report initial firmware status
        reportFirmwareStatus('current', currentFirmwareVersion);
      }
    });

    // Setup direct methods
    setupDirectMethods();

    // Send initial device info
    const deviceInfo = {
      messageType: 'deviceInfo',
      deviceId: deviceId,
      firmwareVersion: currentFirmwareVersion,
      hardwareVersion: hardwareVersion,
      deviceModel: deviceModel,
      lastBoot: new Date().toISOString(),
      transport: 'MQTT'
    };

    const infoMessage = new Message(JSON.stringify(deviceInfo));
    infoMessage.properties.add('messageType', 'deviceInfo');
    infoMessage.properties.add('deviceType', deviceModel);

    client.sendEvent(infoMessage, (err) => {
      if (err) {
        logError(`Failed to send device info: ${err.toString()}`);
      } else {
        logInfo('Device info sent successfully');
      }
    });

    // Start telemetry with staggered timing
    const telemetryDelay = deviceIndex * deviceStaggerDelay;
    
    setTimeout(() => {
      sendTelemetry();
      setInterval(sendTelemetry, telemetryInterval);
    }, telemetryDelay);

    return { 
      deviceId, 
      client, 
      handleOTAUpdate,
      twin,
      getStats: () => ({ 
        deviceId, 
        telemetryCount, 
        errorCount, 
        currentFirmwareVersion,
        isConnected,
        transport: 'MQTT'
      })
    };

  } catch (err) {
    logError(`Error during device initialization: ${err}`);
    throw err;
  }
}

// Main function to start all devices
async function startMultiDeviceSimulator() {
  console.log('='.repeat(60));
  console.log('ESP32 Multi-Device Simulator (MQTT) with Timer');
  console.log('='.repeat(60));
  console.log(`Configuration:`);
  console.log(`- Number of devices: ${numberOfDevices}`);
  console.log(`- Telemetry interval: ${telemetryInterval}ms`);
  console.log(`- Firmware check interval: ${firmwareCheckInterval}ms`);
  console.log(`- Batch size: ${batchSize}`);
  console.log(`- Batch delay: ${batchDelay}ms`);
  console.log(`- Device stagger delay: ${deviceStaggerDelay}ms`);
  console.log(`- Runtime: ${runDurationMinutes} minutes`);
  console.log(`- Auto-shutdown: ${autoShutdown ? 'enabled' : 'disabled'}`);
  console.log(`- Transport: MQTT (with Device Twin & Direct Methods)`);
  console.log('='.repeat(60));

  // Start the simulation timer
  startSimulationTimer();

  const devices = [];
  
  for (let i = 0; i < numberOfDevices; i += batchSize) {
    const batchEnd = Math.min(i + batchSize, numberOfDevices);
    console.log(`Starting devices ${i + 1} to ${batchEnd}...`);
    
    const batchPromises = [];
    for (let j = i; j < batchEnd; j++) {
      batchPromises.push(
        createDeviceSimulator(j + 1).catch(err => {
          console.error(`Failed to start device ${j + 1}: ${err.message}`);
          return null;
        })
      );
    }
    
    const batchDevices = await Promise.all(batchPromises);
    devices.push(...batchDevices.filter(device => device !== null));
    
    if (i + batchSize < numberOfDevices) {
      await new Promise(resolve => setTimeout(resolve, batchDelay));
    }
  }

  console.log(`Successfully started ${devices.length}/${numberOfDevices} devices`);
  if (autoShutdown) {
    console.log(`Simulation will run for ${runDurationMinutes} minutes`);
    console.log('Use extendTimer(minutes) to add more time');
  }
  console.log('Press Ctrl+C to stop all devices');
  console.log('='.repeat(60));
  
  // Store devices globally
  global.devices = devices;
  
  // Global functions
  global.triggerFirmwareUpdateAll = function(version, url) {
    console.log(`Triggering firmware update for all devices: ${version}`);
    devices.forEach(device => {
      if (device && device.handleOTAUpdate) {
        device.handleOTAUpdate({ version, url }).catch(err => {
          console.error(`Firmware update failed for ${device.deviceId}: ${err.message}`);
        });
      }
    });
  };

  global.getStats = function() {
    const stats = devices.map(device => device.getStats());
    const connected = stats.filter(s => s.isConnected).length;
    const totalTelemetry = stats.reduce((sum, s) => sum + s.telemetryCount, 0);
    const totalErrors = stats.reduce((sum, s) => sum + s.errorCount, 0);
    
    console.log('\n' + '='.repeat(60));
    console.log(`MQTT SIMULATOR STATS - ${new Date().toISOString()}`);
    console.log(`Connected devices: ${connected}/${numberOfDevices}`);
    console.log(`Total telemetry sent: ${totalTelemetry}`);
    console.log(`Total errors: ${totalErrors}`);
    console.log(`Average telemetry per device: ${(totalTelemetry / numberOfDevices).toFixed(1)}`);
    console.log(`Transport: MQTT`);
    console.log('='.repeat(60));
    
    return { connected, totalTelemetry, totalErrors, devices: stats, transport: 'MQTT' };
  };

  global.getDevice = function(deviceId) {
    return devices.find(device => device.deviceId === deviceId);
  };

  global.sendDirectMethodToAll = function(methodName, payload = {}) {
    console.log(`Sending direct method '${methodName}' to all devices...`);
    // This would typically be done from the cloud side using Azure IoT Hub service SDK
    console.log('Note: Direct methods are typically invoked from the cloud/backend service');
    console.log('Payload:', JSON.stringify(payload, null, 2));
  };

  // Print periodic stats
  setInterval(() => {
    global.getStats();
  }, statsInterval);

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nReceived SIGINT. Shutting down gracefully...');
    
    const shutdownPromises = devices.map(device => {
      return new Promise((resolve) => {
        if (device && device.client) {
          device.client.close((err) => {
            if (err) {
              console.error(`Error closing ${device.deviceId}: ${err.message}`);
            } else {
              console.log(`[${device.deviceId}] Connection closed`);
            }
            resolve();
          });
        } else {
          resolve();
        }
      });
    });

    await Promise.all(shutdownPromises);
    console.log('All devices disconnected. Exiting...');
    process.exit(0);
  });
}

// Display available global functions
console.log('\nAvailable global functions after startup:');
console.log('- triggerFirmwareUpdateAll(version, url)');
console.log('- getStats()');
console.log('- getDevice(deviceId)');
console.log('- sendDirectMethodToAll(methodName, payload)');
console.log('- devices (array of device objects)');
console.log('\nMQTT Features:');
console.log('- Device Twin support for firmware updates');
console.log('- Direct Methods for remote commands');
console.log('- Persistent connections for better performance');
console.log('- Real-time bidirectional communication');
console.log('\nTo change configuration, edit config.json\n');

// Start the simulator
startMultiDeviceSimulator().catch(err => {
  console.error('Failed to start multi-device simulator:', err);
  process.exit(1);
});
