// sketch.ino file - Enhanced with telemetry
#include <Update.h>
#include "wifi.h"

// Add these to your secret_configs.h file
#ifndef CURRENT_FIRMWARE_VERSION
#define CURRENT_FIRMWARE_VERSION "1.0.0"
#endif

void setup() {
    Serial.begin(115200);
    
    // Wait a moment for serial to initialize
    delay(2000);
    
    Serial.println("=== ESP32 Azure IoT Device Starting ===");
    Serial.printf("Firmware Version: %s\n", CURRENT_FIRMWARE_VERSION);
    Serial.printf("Store ID: %s\n", STORE_ID);
    Serial.printf("Region: %s\n", REGION);
    Serial.printf("Device ID: %s\n", AZURE_DEVICE_ID);
    
    // Start WiFi connection manager
    startWifiConnectionManager();
}

void loop() {
    // Check WiFi connection and reconnect if needed
    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("WiFi disconnected, attempting to reconnect...");
        startWifiConnectionManager();
    } else {
        pollDPSAssignment();
        // WiFi is connected, try to send telemetry if due
        sendTelemetryIfDue();
    }
    
    delay(1000); // Check every second
}

// Optional: Add some utility functions for monitoring
void printSystemStatus() {
    Serial.println("\n=== System Status ===");
    Serial.printf("WiFi Status: %s\n", WiFi.status() == WL_CONNECTED ? "Connected" : "Disconnected");
    
    if (WiFi.status() == WL_CONNECTED) {
        Serial.printf("SSID: %s\n", WiFi.SSID().c_str());
        Serial.printf("IP: %s\n", WiFi.localIP().toString().c_str());
        Serial.printf("Signal: %d dBm\n", WiFi.RSSI());
    }
    
    Serial.printf("Free Heap: %d bytes\n", ESP.getFreeHeap());
    Serial.printf("Uptime: %lu seconds\n", millis() / 1000);
    
    // Check if IoT Hub client is connected
    extern AzureIoTHubClient iotHubClient;
    Serial.printf("IoT Hub Status: %s\n", iotHubClient.isConnected() ? "Connected" : "Not Connected");
    
    time_t now = time(nullptr);
    if (now > 24 * 3600) {
        struct tm timeinfo;
        localtime_r(&now, &timeinfo);
        Serial.printf("Current Time: %04d-%02d-%02d %02d:%02d:%02d UTC\n",
                      timeinfo.tm_year + 1900, timeinfo.tm_mon + 1, timeinfo.tm_mday,
                      timeinfo.tm_hour, timeinfo.tm_min, timeinfo.tm_sec);
    } else {
        Serial.println("Time: Not synchronized");
    }
    
    Serial.println("=====================\n");
}

// You can call this function from serial monitor for debugging
void handleSerialCommands() {
    if (Serial.available()) {
        String command = Serial.readString();
        command.trim();
        command.toLowerCase();
        
        if (command == "status") {
            printSystemStatus();
        } else if (command == "telemetry") {
            extern AzureIoTHubClient iotHubClient;
            if (iotHubClient.isConnected()) {
                String payload = iotHubClient.createTelemetryPayload();
                Serial.println("Sending telemetry on demand...");
                if (iotHubClient.sendTelemetry(payload)) {
                    Serial.println("Telemetry sent successfully");
                } else {
                    Serial.println("Failed to send telemetry");
                }
            } else {
                Serial.println("IoT Hub client not connected");
            }
        } else if (command == "restart") {
            Serial.println("Restarting device...");
            ESP.restart();
        } else if (command == "help") {
            Serial.println("Available commands:");
            Serial.println("  status    - Show system status");
            Serial.println("  telemetry - Send telemetry now");
            Serial.println("  restart   - Restart device");
            Serial.println("  help      - Show this help");
        }
    }
}