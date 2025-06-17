// azure_helper.cpp file - Enhanced implementation
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <cstdlib> 
#include <string.h>

#include "azure_helper.h"

// Global variables
char iotHubHost[128] = "";
char iotHubDeviceId[64] = "";
char iotHubDeviceKey[128] = "";
String dpsOperationId = "";
String sasToken = "";

// Global IoT Hub client instance
AzureIoTHubClient iotHubClient;

// Provisioning context
static char dpsAssignedHub[128] = "";
static char dpsAssignedDeviceId[64] = "";

bool initTime(const char* timezone) {
    Serial.println("Synchronizing time with NTP server...");
    
    configTime(0, 0, "pool.ntp.org", "time.nist.gov", "time.google.com");
    
    time_t now = time(nullptr);
    int timeout = 0;
    
    // Wait up to 15 seconds for NTP sync
    while (now < 24 * 3600 && timeout < 150) {
        delay(100);
        now = time(nullptr);
        if (timeout % 10 == 0) Serial.print(".");
        timeout++;
    }
    
    if (now < 24 * 3600) {
        Serial.println("\nERROR: Time synchronization failed!");
        return false;
    }
    
    Serial.println("\nTime synchronized successfully!");
    struct tm timeinfo;
    localtime_r(&now, &timeinfo);
    Serial.printf("Current time: %04d-%02d-%02d %02d:%02d:%02d UTC\n",
                  timeinfo.tm_year + 1900, timeinfo.tm_mon + 1, timeinfo.tm_mday,
                  timeinfo.tm_hour, timeinfo.tm_min, timeinfo.tm_sec);
    return true;
}

void startAzureProvisioning() {
    if (!initTime()) {
        Serial.println("Cannot proceed without time synchronization");
        return;
    }
    
    delay(1000);
    uint32_t expiry = time(NULL) + 3600;
    Serial.printf("Current time: %u, Token expiry: %u\n", (uint32_t)time(NULL), expiry);

    // If using enrollment groups, derive the individual device key
    String deviceKey = AZURE_SYMMETRIC_KEY;
    
    Serial.println("Deriving device key from enrollment group key...");
    deviceKey = deriveDeviceKey(AZURE_SYMMETRIC_KEY, AZURE_DEVICE_ID);
    
    if (deviceKey.length() == 0) {
        Serial.println("Failed to derive device key");
        return;
    }
    
    // Generate DPS SAS token using the DERIVED device key
    azureSASTokenGenerator dpsTokenGen(AZURE_ID_SCOPE, AZURE_DEVICE_ID, deviceKey);
    sasToken = dpsTokenGen.generateSASToken(expiry);
    
    if (sasToken.length() == 0) {
        Serial.println("\nFailed to generate DPS SAS token");
        return;
    }
    
    Serial.println("Generated DPS SAS Token: " + sasToken);
    Serial.println("\nStarting Azure DPS registration...");
    
    // Create secure client for HTTPS
    WiFiClientSecure client;
    client.setInsecure();
    
    HTTPClient http;
    
    // Build DPS registration URL
    String url = String("https://") + AZURE_DPS_FQDN_ENDPOINT + "/" + AZURE_ID_SCOPE + 
                 "/registrations/" + AZURE_DEVICE_ID + "/register?api-version=2019-03-31";
    
    if (!http.begin(client, url)) {
        Serial.println("DPS: HTTP begin failed");
        return;
    }
    
    // Set headers
    http.addHeader("Authorization", sasToken);
    http.addHeader("Content-Type", "application/json");
    
    // Create registration payload
    ArduinoJson::JsonDocument doc;
    doc["registrationId"] = AZURE_DEVICE_ID;
    
    String body;
    serializeJson(doc, body);
    
    // Send registration request
    Serial.println("Sending DPS registration request...");
    Serial.println("URL: " + url);
    Serial.println("Body: " + body);
    
    int httpCode = http.PUT((uint8_t*)body.c_str(), body.length());
    String response = http.getString();
    http.end();
    
    if (httpCode != HTTP_CODE_ACCEPTED) {
        Serial.printf("DPS registration failed with code: %d\n", httpCode);
        Serial.println("Response: " + response);
        return;
    }
    
    // Parse response to get operation ID
    ArduinoJson::JsonDocument responseDoc;
    if (deserializeJson(responseDoc, response)) {
        Serial.println("Failed to parse DPS registration response");
        return;
    }
    
    dpsOperationId = responseDoc["operationId"].as<String>();
    Serial.println("DPS registration initiated, operation ID: " + dpsOperationId);
    
    // Store the derived device key for later IoT Hub use
    strncpy(iotHubDeviceKey, deviceKey.c_str(), sizeof(iotHubDeviceKey) - 1);
    
    // Now poll for assignment status
    pollDPSAssignment();
}

void pollDPSAssignment() {
    const int maxRetries = 20;
    const int pollInterval = 3000;
    
    for (int attempt = 0; attempt < maxRetries; attempt++) {
        delay(pollInterval);
        
        WiFiClientSecure client;
        client.setInsecure();
        HTTPClient http;
        
        String url = String("https://") + AZURE_DPS_FQDN_ENDPOINT + "/" + AZURE_ID_SCOPE + 
                     "/registrations/" + AZURE_DEVICE_ID + "/operations/" + dpsOperationId + 
                     "?api-version=2019-03-31";
        
        if (!http.begin(client, url)) {
            Serial.println("DPS polling: HTTP begin failed");
            continue;
        }
        
        http.addHeader("Authorization", sasToken);
        int httpCode = http.GET();
        String response = http.getString();
        http.end();
        
        if (httpCode == HTTP_CODE_OK) {
            ArduinoJson::JsonDocument doc;
            if (!deserializeJson(doc, response)) {
                String status = doc["status"].as<String>();
                Serial.println("DPS Status: " + status);
                
                if (status == "assigned") {
                    // Device has been assigned to an IoT Hub
                    String assignedHub = doc["registrationState"]["assignedHub"];
                    String deviceId = doc["registrationState"]["deviceId"];
                    
                    Serial.println("DPS Assignment successful!");
                    Serial.println("Assigned Hub: " + assignedHub);
                    Serial.println("Device ID: " + deviceId);
                    
                    // Store the assignment details
                    strncpy(iotHubHost, assignedHub.c_str(), sizeof(iotHubHost) - 1);
                    strncpy(iotHubDeviceId, deviceId.c_str(), sizeof(iotHubDeviceId) - 1);
                    
                    // Initialize IoT Hub client
                    if (iotHubClient.initialize(String(iotHubHost), String(iotHubDeviceId), String(iotHubDeviceKey))) {
                        Serial.println("IoT Hub client initialized successfully");
                        
                        // Send initial telemetry
                        String payload = iotHubClient.createTelemetryPayload();
                        if (iotHubClient.sendTelemetry(payload)) {
                            Serial.println("Initial telemetry sent successfully");
                        }
                    } else {
                        Serial.println("Failed to initialize IoT Hub client");
                    }
                    
                    Serial.println("Azure DPS provisioning completed successfully");
                    return;
                }
                else if (status == "failed") {
                    Serial.println("DPS provisioning failed");
                    Serial.println("Error details: " + response);
                    return;
                }
                // If status is "assigning", continue polling
            }
        }
        
        Serial.printf("DPS polling attempt %d/%d\n", attempt + 1, maxRetries);
    }
    
    Serial.println("DPS provisioning timed out");
}

String deriveDeviceKey(const String &enrollmentGroupKey, const String &deviceId) {
    // Decode the enrollment group key
    size_t keyLen;
    uint8_t keyBin[64];
    
    int decodeResult = mbedtls_base64_decode(keyBin, sizeof(keyBin), &keyLen,
                                            (const unsigned char*)enrollmentGroupKey.c_str(), 
                                            enrollmentGroupKey.length());
    
    if (decodeResult != 0) {
        Serial.printf("ERROR: Failed to decode enrollment group key: %d\n", decodeResult);
        return String();
    }
    
    // Compute HMAC-SHA256 of device ID using enrollment group key
    uint8_t hmac[32];
    int hmacResult = mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256),
                                    keyBin, keyLen,
                                    (const uint8_t*)deviceId.c_str(), deviceId.length(), 
                                    hmac);
    
    if (hmacResult != 0) {
        Serial.printf("ERROR: HMAC computation failed: %d\n", hmacResult);
        return String();
    }
    
    // Base64 encode the result
    char deviceKey[64];
    size_t deviceKeyLen;
    int encodeResult = mbedtls_base64_encode((unsigned char*)deviceKey, sizeof(deviceKey), 
                                            &deviceKeyLen, hmac, sizeof(hmac));
    
    if (encodeResult != 0) {
        Serial.printf("ERROR: Failed to encode device key: %d\n", encodeResult);
        return String();
    }
    
    String derivedKey = String(deviceKey, deviceKeyLen);
    Serial.println("Device key derived successfully");
    
    return derivedKey;
}

void sendTelemetryIfDue() {
    static unsigned long lastTelemetrySent = 0;
    const unsigned long TELEMETRY_INTERVAL = 10000; // 30 seconds in milliseconds
    
    unsigned long currentTime = millis();
    
    // Check if IoT Hub client is properly initialized
    if (!iotHubClient.isConnected()) {
        // Reset the timer when not connected so we send immediately when reconnected
        lastTelemetrySent = currentTime;
        return;
    }
    
    // Check if 30 seconds have passed since last telemetry
    if (currentTime - lastTelemetrySent >= TELEMETRY_INTERVAL) {
        Serial.println("Sending periodic telemetry...");
        
        // Create the telemetry payload
        String payload = iotHubClient.createTelemetryPayload();
        
        // Send to Azure IoT Hub
        if (iotHubClient.sendTelemetry(payload)) {
            Serial.println("Telemetry sent successfully");
            // Update the last sent time only on successful send
            lastTelemetrySent = currentTime;
        } else {
            Serial.println("Failed to send telemetry - will retry");
            // Don't update lastTelemetrySent so we retry sooner
        }
    }
}
