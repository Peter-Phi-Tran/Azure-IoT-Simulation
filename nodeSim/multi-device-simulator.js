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

// Configuration
const NUM_DEVICES = 500;
const TELEMETRY_INTERVAL = 1000; // 10 seconds
const FIRMWARE_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes

// Device firmware information
const CURRENT_FIRMWARE_VERSION = "1.0.0";
const HARDWARE_VERSION = "ESP32-v1.2";
const DEVICE_MODEL = "SimulatedESP32";

// Your DPS details for group enrollment
const idScope = "";
const groupEnrollmentKey = "";

// Store all device instances
const deviceInstances = new Map();

// Function to derive device key from group enrollment key
function deriveDeviceKey(groupKey, deviceId) {
  const hmac = crypto.createHmac('sha256', Buffer.from(groupKey, 'base64'));
  hmac.update(deviceId);
  return hmac.digest('base64');
}

// Device class to encapsulate each device's functionality
class SimulatedDevice {
  constructor(deviceIndex) {
    this.deviceId = `SimulatedESP32-${deviceIndex.toString().padStart(3, '0')}`;
    this.deviceIndex = deviceIndex;
    this.currentFirmwareVersion = CURRENT_FIRMWARE_VERSION;
    this.client = null;
    this.isConnected = false;
    this.telemetryInterval = null;
    this.firmwareCheckInterval = null;
    this.deviceKey = deriveDeviceKey(groupEnrollmentKey, this.deviceId);
    this.lastTelemetryTime = null;
    this.telemetryCount = 0;
    this.errorCount = 0;
  }

  // HTTP-based firmware update checking (polling approach)
  async checkForFirmwareUpdates() {
    try {
      console.log(`[${this.deviceId}] Checking for firmware updates...`);
      
      // For demo purposes, we'll simulate checking a REST endpoint
      // In real implementation, you'd call your backend service that
      // manages firmware updates and checks device twin desired properties
      
      return null; // No update available for now
    } catch (error) {
      console.error(`[${this.deviceId}] Error checking for firmware updates:`, error.message);
      this.errorCount++;
      return null;
    }
  }

  // Download firmware from blob storage
  downloadFirmware(url, filePath) {
    return new Promise((resolve, reject) => {
      console.log(`[${this.deviceId}] Downloading firmware from: ${url}`);
      
      const file = fs.createWriteStream(filePath);
      const request = https.get(url, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`Download failed with status: ${response.statusCode}`));
          return;
        }

        response.pipe(file);
        
        file.on('finish', () => {
          file.close();
          console.log(`[${this.deviceId}] Firmware download completed`);
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
  async installFirmware(filePath, targetVersion) {
    console.log(`[${this.deviceId}] Installing firmware version ${targetVersion}...`);
    
    // Simulate installation time
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Simulate successful installation
    this.currentFirmwareVersion = targetVersion;
    console.log(`[${this.deviceId}] Firmware updated to version ${this.currentFirmwareVersion}`);
    
    // Clean up downloaded file
    try {
      fs.unlinkSync(filePath);
      console.log(`[${this.deviceId}] Firmware file cleaned up`);
    } catch (err) {
      console.warn(`[${this.deviceId}] Could not clean up firmware file:`, err.message);
    }
  }

  // Send firmware status via telemetry
  sendFirmwareStatus(status, targetVersion = null, error = null) {
    if (!this.isConnected) return;

    const statusData = {
      messageType: 'firmwareStatus',
      deviceId: this.deviceId,
      currentVersion: this.currentFirmwareVersion,
      status: status,
      timestamp: new Date().toISOString()
    };

    if (targetVersion) statusData.targetVersion = targetVersion;
    if (error) statusData.error = error;

    const message = new Message(JSON.stringify(statusData));
    message.properties.add('messageType', 'firmwareStatus');
    message.properties.add('deviceType', DEVICE_MODEL);

    this.client.sendEvent(message, (err) => {
      if (err) {
        console.error(`[${this.deviceId}] Failed to send firmware status:`, err.toString());
        this.errorCount++;
      } else {
        console.log(`[${this.deviceId}] Firmware status sent: ${status}`);
      }
    });
  }

  // Handle OTA update process
  async handleOTAUpdate(updateInfo) {
    const { version, url } = updateInfo;
    
    if (version === this.currentFirmwareVersion) {
      console.log(`[${this.deviceId}] Already running firmware version ${version}`);
      return;
    }

    console.log(`[${this.deviceId}] OTA Update requested: ${this.currentFirmwareVersion} -> ${version}`);
    
    // Report update started
    this.sendFirmwareStatus('downloading', version);

    try {
      // Download firmware
      const firmwarePath = path.join(__dirname, `firmware_${this.deviceId}_${version}.bin`);
      await this.downloadFirmware(url, firmwarePath);
      
      // Report download complete, starting installation
      this.sendFirmwareStatus('installing', version);

      // Install firmware
      await this.installFirmware(firmwarePath, version);
      
      // Report successful installation
      this.sendFirmwareStatus('completed', version);
      console.log(`[${this.deviceId}] OTA update completed successfully`);

    } catch (error) {
      console.error(`[${this.deviceId}] OTA update failed:`, error);
      this.sendFirmwareStatus('failed', version, error.message);
      this.errorCount++;
    }
  }

  // Setup HTTP-based command handling
  setupCommandHandling() {
    console.log(`[${this.deviceId}] Setting up HTTP-based update checking...`);
    
    // Check for firmware updates every 5 minutes (staggered to avoid all devices checking at once)
    const staggeredDelay = (this.deviceIndex * 1000); // 1 second per device stagger
    
    setTimeout(() => {
      this.firmwareCheckInterval = setInterval(async () => {
        const updateInfo = await this.checkForFirmwareUpdates();
        if (updateInfo && updateInfo.updateAvailable) {
          await this.handleOTAUpdate(updateInfo);
        }
      }, FIRMWARE_CHECK_INTERVAL);
    }, staggeredDelay);
  }

  // Telemetry generation functions
  getRandomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  generateTelemetry() {
    return {
      messageType: 'telemetry',
      temperature: this.getRandomInt(30, 45),
      uvIndex: this.getRandomInt(1, 12),
      sessionTime: this.getRandomInt(0, 20),
      humidity: this.getRandomInt(20, 60),
      boothDoorOpen: Math.random() > 0.95,
      deviceId: this.deviceId,
      firmwareVersion: this.currentFirmwareVersion,
      timestamp: new Date().toISOString()
    };
  }

  sendTelemetry() {
    if (!this.isConnected) return;

    const data = this.generateTelemetry();
    const message = new Message(JSON.stringify(data));
    
    // Add message properties for better routing/filtering
    message.properties.add('messageType', 'telemetry');
    message.properties.add('deviceType', DEVICE_MODEL);
    message.properties.add('enrollmentType', 'group');
    message.properties.add('firmwareVersion', this.currentFirmwareVersion);
    
    this.client.sendEvent(message, (err) => {
      if (err) {
        console.error(`[${this.deviceId}] Failed to send message:`, err.toString());
        this.errorCount++;
      } else {
        this.telemetryCount++;
        this.lastTelemetryTime = new Date().toISOString();
        if (this.telemetryCount % 10 === 0) { // Log every 10th message to reduce noise
          console.log(`[${this.deviceId}] Telemetry sent successfully (Count: ${this.telemetryCount})`);
        }
      }
    });
  }

  // Initialize and connect the device
  async initialize() {
    try {
      console.log(`[${this.deviceId}] Starting device simulation - Firmware v${this.currentFirmwareVersion}`);
      
      // Create security client for DPS using derived device key
      const securityClient = new SymmetricKeySecurityClient(this.deviceId, this.deviceKey);

      // Create provisioning client
      const provisioningClient = ProvisioningDeviceClient.create(
        'global.azure-devices-provisioning.net',
        idScope,
        new ProvisioningHttp(),
        securityClient
      );

      // Register device with DPS using group enrollment
      console.log(`[${this.deviceId}] Registering device with group enrollment...`);
      
      const result = await new Promise((resolve, reject) => {
        provisioningClient.register((err, deviceResult) => {
          if (err) {
            console.error(`[${this.deviceId}] Registration failed:`, err);
            reject(err);
            return;
          }
          resolve(deviceResult);
        });
      });
      
      console.log(`[${this.deviceId}] Registration succeeded - Hub: ${result.assignedHub}`);

      // Build the device connection string for IoT Hub using the derived device key
      const deviceConnectionString = `HostName=${result.assignedHub};DeviceId=${result.deviceId};SharedAccessKey=${this.deviceKey}`;

      // Create device client using HTTP
      this.client = Client.fromConnectionString(deviceConnectionString, DeviceHttp);

      // Connect to IoT Hub
      await new Promise((resolve, reject) => {
        this.client.open((err) => {
          if (err) {
            console.error(`[${this.deviceId}] Could not connect:`, err.message);
            reject(err);
            return;
          }
          console.log(`[${this.deviceId}] Connected to IoT Hub via HTTP`);
          this.isConnected = true;
          resolve();
        });
      });

      // Setup command handling
      this.setupCommandHandling();

      // Send initial device info
      await this.sendDeviceInfo();

      // Start telemetry with staggered timing to avoid all devices sending at once
      const telemetryStagger = (this.deviceIndex * 200); // 200ms stagger between devices
      setTimeout(() => {
        this.sendTelemetry(); // Send initial telemetry
        this.telemetryInterval = setInterval(() => {
          this.sendTelemetry();
        }, TELEMETRY_INTERVAL);
      }, telemetryStagger);

    } catch (err) {
      console.error(`[${this.deviceId}] Error during device initialization:`, err);
      this.errorCount++;
      throw err;
    }
  }

  // Send initial device info
  async sendDeviceInfo() {
    const deviceInfo = {
      messageType: 'deviceInfo',
      deviceId: this.deviceId,
      firmwareVersion: this.currentFirmwareVersion,
      hardwareVersion: HARDWARE_VERSION,
      deviceModel: DEVICE_MODEL,
      lastBoot: new Date().toISOString(),
      transport: 'HTTP'
    };

    const infoMessage = new Message(JSON.stringify(deviceInfo));
    infoMessage.properties.add('messageType', 'deviceInfo');
    infoMessage.properties.add('deviceType', DEVICE_MODEL);

    return new Promise((resolve, reject) => {
      this.client.sendEvent(infoMessage, (err) => {
        if (err) {
          console.error(`[${this.deviceId}] Failed to send device info:`, err.toString());
          this.errorCount++;
          reject(err);
        } else {
          console.log(`[${this.deviceId}] Device info sent successfully`);
          resolve();
        }
      });
    });
  }

  // Clean shutdown
  async shutdown() {
    console.log(`[${this.deviceId}] Shutting down...`);
    
    if (this.telemetryInterval) {
      clearInterval(this.telemetryInterval);
    }
    
    if (this.firmwareCheckInterval) {
      clearInterval(this.firmwareCheckInterval);
    }

    if (this.client && this.isConnected) {
      await new Promise((resolve) => {
        this.client.close(() => {
          console.log(`[${this.deviceId}] Connection closed`);
          this.isConnected = false;
          resolve();
        });
      });
    }
  }

  // Get device statistics
  getStats() {
    return {
      deviceId: this.deviceId,
      isConnected: this.isConnected,
      telemetryCount: this.telemetryCount,
      errorCount: this.errorCount,
      lastTelemetryTime: this.lastTelemetryTime,
      firmwareVersion: this.currentFirmwareVersion
    };
  }
}

// Main application class
class MultiDeviceSimulator {
  constructor() {
    this.devices = new Map();
    this.statsInterval = null;
    this.isRunning = false;
  }

  async start() {
    console.log(`Starting multi-device simulator with ${NUM_DEVICES} devices...`);
    console.log('Transport: HTTP');
    console.log('Telemetry interval:', TELEMETRY_INTERVAL, 'ms');
    console.log('Firmware check interval:', FIRMWARE_CHECK_INTERVAL, 'ms');
    console.log('----------------------------------------');

    this.isRunning = true;
    
    // Create and initialize devices in batches to avoid overwhelming the system
    const BATCH_SIZE = 10;
    const BATCH_DELAY = 2000; // 2 seconds between batches
    
    for (let i = 0; i < NUM_DEVICES; i += BATCH_SIZE) {
      const batchEnd = Math.min(i + BATCH_SIZE, NUM_DEVICES);
      console.log(`Initializing devices ${i + 1} to ${batchEnd}...`);
      
      const batchPromises = [];
      for (let j = i; j < batchEnd; j++) {
        const device = new SimulatedDevice(j + 1);
        this.devices.set(device.deviceId, device);
        deviceInstances.set(device.deviceId, device);
        
        batchPromises.push(
          device.initialize().catch(err => {
            console.error(`Failed to initialize ${device.deviceId}:`, err.message);
            return null;
          })
        );
      }
      
      await Promise.all(batchPromises);
      
      // Wait between batches (except for the last batch)
      if (i + BATCH_SIZE < NUM_DEVICES) {
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
      }
    }

    // Start periodic stats reporting
    this.startStatsReporting();
    
    console.log('----------------------------------------');
    console.log(`All ${NUM_DEVICES} devices initialized and running`);
    console.log('Press Ctrl+C to stop the simulation');
  }

  startStatsReporting() {
    this.statsInterval = setInterval(() => {
      this.printStats();
    }, 30000); // Print stats every 30 seconds
  }

  printStats() {
    const stats = Array.from(this.devices.values()).map(device => device.getStats());
    const connected = stats.filter(s => s.isConnected).length;
    const totalTelemetry = stats.reduce((sum, s) => sum + s.telemetryCount, 0);
    const totalErrors = stats.reduce((sum, s) => sum + s.errorCount, 0);
    
    console.log('========================================');
    console.log(`SIMULATOR STATS - ${new Date().toISOString()}`);
    console.log(`Connected devices: ${connected}/${NUM_DEVICES}`);
    console.log(`Total telemetry sent: ${totalTelemetry}`);
    console.log(`Total errors: ${totalErrors}`);
    console.log(`Average telemetry per device: ${(totalTelemetry / NUM_DEVICES).toFixed(1)}`);
    console.log('========================================');
  }

  async shutdown() {
    console.log('\nShutting down multi-device simulator...');
    this.isRunning = false;
    
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
    }

    // Shutdown all devices
    const shutdownPromises = Array.from(this.devices.values()).map(device => 
      device.shutdown().catch(err => {
        console.error(`Error shutting down ${device.deviceId}:`, err.message);
      })
    );

    await Promise.all(shutdownPromises);
    console.log('All devices shut down successfully');
  }

  // Get device by ID for manual operations
  getDevice(deviceId) {
    return this.devices.get(deviceId);
  }

  // Trigger firmware update for all devices
  async triggerFirmwareUpdateAll(version, url) {
    console.log(`Triggering firmware update for all devices: ${version}`);
    const updatePromises = Array.from(this.devices.values()).map(device => 
      device.handleOTAUpdate({ version, url }).catch(err => {
        console.error(`Firmware update failed for ${device.deviceId}:`, err.message);
      })
    );
    
    await Promise.all(updatePromises);
  }

  // Trigger firmware update for specific device
  async triggerFirmwareUpdate(deviceId, version, url) {
    const device = this.devices.get(deviceId);
    if (!device) {
      console.error(`Device ${deviceId} not found`);
      return;
    }
    
    await device.handleOTAUpdate({ version, url });
  }
}

// Create and start the simulator
const simulator = new MultiDeviceSimulator();

// Handle process termination gracefully
process.on('SIGINT', async () => {
  console.log('\nReceived SIGINT. Shutting down gracefully...');
  await simulator.shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nReceived SIGTERM. Shutting down gracefully...');
  await simulator.shutdown();
  process.exit(0);
});

// Expose global functions for manual testing
global.simulator = simulator;
global.triggerFirmwareUpdateAll = function(version, url) {
  simulator.triggerFirmwareUpdateAll(version, url);
};
global.triggerFirmwareUpdate = function(deviceId, version, url) {
  simulator.triggerFirmwareUpdate(deviceId, version, url);
};
global.getDeviceStats = function() {
  simulator.printStats();
};
global.getDevice = function(deviceId) {
  return simulator.getDevice(deviceId);
};

console.log('=== Multi-Device Simulator ===');
console.log('Available global functions:');
console.log('- triggerFirmwareUpdateAll(version, url)');
console.log('- triggerFirmwareUpdate(deviceId, version, url)');
console.log('- getDeviceStats()');
console.log('- getDevice(deviceId)');
console.log('===============================');

// Start the simulation
simulator.start().catch(err => {
  console.error('Failed to start simulator:', err);
  process.exit(1);
});
