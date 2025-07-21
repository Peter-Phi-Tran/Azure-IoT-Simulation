'use strict';

const { ProvisioningDeviceClient } = require('azure-iot-provisioning-device'); 
const { Http: ProvisioningHttp } = require('azure-iot-provisioning-device-http');
const { SymmetricKeySecurityClient } = require('azure-iot-security-symmetric-key');
const { Client, Message } = require('azure-iot-device');
const { Http: DeviceHttp } = require('azure-iot-device-http');
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Device firmware information
const CURRENT_FIRMWARE_VERSION = "1.0.0";
const HARDWARE_VERSION = "ESP32-v1.2";
const DEVICE_MODEL = "SimulatedESP32";

// Your DPS details for group enrollment
const idScope = "";
const groupEnrollmentKey = "";
const deviceId = ""  ;

let currentFirmwareVersion = CURRENT_FIRMWARE_VERSION;
let client;

// Function to derive device key from group enrollment key
function deriveDeviceKey(groupKey, deviceId) {
  const hmac = crypto.createHmac('sha256', Buffer.from(groupKey, 'base64'));
  hmac.update(deviceId);
  return hmac.digest('base64');
}

// HTTP-based firmware update checking (polling approach)
async function checkForFirmwareUpdates() {
  try {
    // This would typically call your backend API or Azure Function
    // that checks the desired properties and returns update info
    console.log('Checking for firmware updates...');
    
    // For demo purposes, we'll simulate checking a REST endpoint
    // In real implementation, you'd call your backend service that
    // manages firmware updates and checks device twin desired properties
    
    // Example: GET https://yourbackend.com/api/firmware-check?deviceId=SimulatedESP32
    // Response would contain: { updateAvailable: true, version: "1.1.0", downloadUrl: "..." }
    
    return null; // No update available for now
  } catch (error) {
    console.error('Error checking for firmware updates:', error.message);
    return null;
  }
}

// Download firmware from blob storage
function downloadFirmware(url, filePath) {
  return new Promise((resolve, reject) => {
    console.log(`Downloading firmware from: ${url}`);
    
    const file = fs.createWriteStream(filePath);
    const request = https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Download failed with status: ${response.statusCode}`));
        return;
      }

      response.pipe(file);
      
      file.on('finish', () => {
        file.close();
        console.log('Firmware download completed');
        resolve();
      });
    });

    request.on('error', (err) => {
      fs.unlink(filePath, () => {}); // Delete partial file
      reject(err);
    });

    file.on('error', (err) => {
      fs.unlink(filePath, () => {}); // Delete partial file
      reject(err);
    });
  });
}

// Simulate firmware installation
async function installFirmware(filePath, targetVersion) {
  console.log(`Installing firmware version ${targetVersion}...`);
  
  // Simulate installation time
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  // Simulate successful installation
  currentFirmwareVersion = targetVersion;
  console.log(`Firmware updated to version ${currentFirmwareVersion}`);
  
  // Clean up downloaded file
  try {
    fs.unlinkSync(filePath);
    console.log('Firmware file cleaned up');
  } catch (err) {
    console.warn('Could not clean up firmware file:', err.message);
  }
}

// Send firmware status via telemetry (since Device Twin isn't available over HTTP)
function sendFirmwareStatus(status, targetVersion = null, error = null) {
  const statusData = {
    messageType: 'firmwareStatus',
    deviceId: deviceId,
    currentVersion: currentFirmwareVersion,
    status: status,
    timestamp: new Date().toISOString()
  };

  if (targetVersion) statusData.targetVersion = targetVersion;
  if (error) statusData.error = error;

  const message = new Message(JSON.stringify(statusData));
  message.properties.add('messageType', 'firmwareStatus');
  message.properties.add('deviceType', DEVICE_MODEL);

  client.sendEvent(message, (err) => {
    if (err) {
      console.error('Failed to send firmware status:', err.toString());
    } else {
      console.log(`Firmware status sent: ${status}`);
    }
  });
}

// Handle OTA update process (HTTP polling approach)
async function handleOTAUpdate(updateInfo) {
  const { version, url } = updateInfo;
  
  if (version === currentFirmwareVersion) {
    console.log(`Already running firmware version ${version}`);
    return;
  }

  console.log(`OTA Update requested: ${currentFirmwareVersion} -> ${version}`);
  
  // Report update started
  sendFirmwareStatus('downloading', version);

  try {
    // Download firmware
    const firmwarePath = path.join(__dirname, `firmware_${version}.bin`);
    await downloadFirmware(url, firmwarePath);
    
    // Report download complete, starting installation
    sendFirmwareStatus('installing', version);

    // Install firmware
    await installFirmware(firmwarePath, version);
    
    // Report successful installation
    sendFirmwareStatus('completed', version);
    console.log('OTA update completed successfully');

  } catch (error) {
    console.error('OTA update failed:', error);
    sendFirmwareStatus('failed', version, error.message);
  }
}

// HTTP-based method to receive commands/updates
function setupCommandHandling() {
  // Note: HTTP transport doesn't support real-time commands like MQTT
  // For HTTP-based OTA updates, you would typically:
  // 1. Poll a REST API periodically for updates
  // 2. Use Azure Functions with HTTP triggers
  // 3. Implement webhook endpoints
  
  console.log('Setting up HTTP-based update checking...');
  
  // Check for firmware updates every 5 minutes
  setInterval(async () => {
    const updateInfo = await checkForFirmwareUpdates();
    if (updateInfo && updateInfo.updateAvailable) {
      await handleOTAUpdate(updateInfo);
    }
  }, 5 * 60 * 1000); // 5 minutes
}

// Derive the device-specific key
const deviceKey = deriveDeviceKey(groupEnrollmentKey, deviceId);
console.log('Derived device key for device:', deviceId);

// Create security client for DPS using derived device key
const securityClient = new SymmetricKeySecurityClient(deviceId, deviceKey);

// Create provisioning client
const provisioningClient = ProvisioningDeviceClient.create(
  'global.azure-devices-provisioning.net',
  idScope,
  new ProvisioningHttp(),
  securityClient
);

async function main() {
  try {
    console.log(`Starting device simulation - Firmware v${currentFirmwareVersion}`);
    console.log('Transport: HTTP (Note: Device Twin not supported, using telemetry for status)');
    
    // Register device with DPS using group enrollment
    console.log('Registering device with group enrollment...');
    console.log('Device ID:', deviceId);
    
    const result = await new Promise((resolve, reject) => {
      provisioningClient.register((err, deviceResult) => {
        if (err) {
          console.error('Registration failed:', err);
          reject(err);
          return;
        }
        resolve(deviceResult);
      });
    });
    
    console.log('Registration succeeded');
    console.log('Assigned Hub:', result.assignedHub);
    console.log('Device ID:', result.deviceId);

    // Build the device connection string for IoT Hub using the derived device key
    const deviceConnectionString = `HostName=${result.assignedHub};DeviceId=${result.deviceId};SharedAccessKey=${deviceKey}`;

    // Create device client using HTTP
    client = Client.fromConnectionString(deviceConnectionString, DeviceHttp);

    client.open((err) => {
      if (err) {
        console.error('Could not connect: ' + err.message);
        return;
      }
      console.log('Client connected to IoT Hub via group enrollment using HTTP.');

      // Setup HTTP-based command handling (polling approach)
      setupCommandHandling();

      // Send initial device info
      const deviceInfo = {
        messageType: 'deviceInfo',
        deviceId: deviceId,
        firmwareVersion: currentFirmwareVersion,
        hardwareVersion: HARDWARE_VERSION,
        deviceModel: DEVICE_MODEL,
        lastBoot: new Date().toISOString(),
        transport: 'HTTP'
      };

      const infoMessage = new Message(JSON.stringify(deviceInfo));
      infoMessage.properties.add('messageType', 'deviceInfo');
      infoMessage.properties.add('deviceType', DEVICE_MODEL);

      client.sendEvent(infoMessage, (err) => {
        if (err) {
          console.error('Failed to send device info:', err.toString());
        } else {
          console.log('Device info sent successfully');
        }
      });

      // Telemetry generation functions
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
        const data = generateTelemetry();
        const message = new Message(JSON.stringify(data));
        
        // Add message properties for better routing/filtering
        message.properties.add('messageType', 'telemetry');
        message.properties.add('deviceType', DEVICE_MODEL);
        message.properties.add('enrollmentType', 'group');
        message.properties.add('firmwareVersion', currentFirmwareVersion);
        
        console.log('Sending telemetry:', JSON.stringify(data, null, 2));
        
        client.sendEvent(message, (err) => {
          if (err) {
            console.error('Failed to send message:', err.toString());
          } else {
            console.log(`Telemetry sent successfully at ${new Date().toISOString()}`);
          }
        });
      }

      // Send telemetry every 10 seconds
      setInterval(sendTelemetry, 10000);
      
      // Send initial telemetry immediately
      sendTelemetry();
    });

    // Handle process termination gracefully
    process.on('SIGINT', () => {
      console.log('\nReceived SIGINT. Closing connection...');
      client.close(() => {
        console.log('Connection closed. Exiting...');
        process.exit(0);
      });
    });

  } catch (err) {
    console.error('Error during device registration:', err);
    process.exit(1);
  }
}

// Expose a function to manually trigger firmware update (for testing)
global.triggerFirmwareUpdate = function(version, url) {
  console.log('Manual firmware update triggered');
  handleOTAUpdate({ version, url });
};

console.log('Note: To manually trigger a firmware update, call:');
console.log('triggerFirmwareUpdate("1.1.0", "https://your-blob-url/firmware.bin")');

main();