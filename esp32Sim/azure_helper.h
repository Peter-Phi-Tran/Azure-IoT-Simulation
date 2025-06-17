// azure_helper.h file - Enhanced with IoT Hub connection
#include <az_core.h>
#include <az_iot_hub_client.h>
#include <az_iot_provisioning_client.h>
#include <mbedtls/md.h>
#include <mbedtls/base64.h>
#include <time.h>
#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>

#include "secret_configs.h"

class azureSASTokenGenerator {
  public:
    enum ServiceType {
      DPS_SERVICE,
      IOT_HUB_SERVICE
    };

  private:
    ServiceType serviceType;
    String endpoint;
    String scopeID; 
    String deviceID;
    String registrationID;
    String symmetricKey;
    uint32_t tokenExpiry;

  public:
    azureSASTokenGenerator(const String &idScope, const String &regID, const String &symKey)
      : serviceType(DPS_SERVICE), scopeID(idScope), registrationID(regID), symmetricKey(symKey), tokenExpiry(0) {
      endpoint = AZURE_DPS_FQDN_ENDPOINT;
    }  

    azureSASTokenGenerator(const String &hubHost, const String &devID, const String &symKey, bool isHub)
      : serviceType(IOT_HUB_SERVICE), endpoint(hubHost), deviceID(devID), symmetricKey(symKey), tokenExpiry(0) {}
    
    String generateSASToken(uint32_t expiry = 0) {
      if(expiry == 0){
        expiry = time(NULL) + 3600; // Default 1 hour expiry
      }
      tokenExpiry = expiry;

      switch(serviceType) {
        case DPS_SERVICE:
          return generateDpsToken(expiry);
        case IOT_HUB_SERVICE:
          return generateHubToken(expiry);
        default:
          return String("Could not generate SAS Token");
      }
    }

    bool IsExpired() {
      return time(NULL) >= (tokenExpiry - 300); // Refresh 5 minutes before expiry
    }

  private:
    String generateDpsToken(uint32_t expiry) {
      az_iot_provisioning_client provClient;
      az_iot_provisioning_client_options provOptions = az_iot_provisioning_client_options_default(); 

      az_result result_client = az_iot_provisioning_client_init(&provClient,
                                                                az_span_create((uint8_t*)endpoint.c_str(), endpoint.length()),                                
                                                                az_span_create((uint8_t*)scopeID.c_str(), scopeID.length()),
                                                                az_span_create((uint8_t*)registrationID.c_str(), registrationID.length()),
                                                                &provOptions);

      if(az_result_failed(result_client)) return String("IoT DPS Client Initialization failed");

      return generateTokenCommon(&provClient, expiry, true);
    }

    String generateHubToken(uint32_t expiry) {
      az_iot_hub_client hubClient;
      az_iot_hub_client_options hubOptions = az_iot_hub_client_options_default();

      az_result result_client = az_iot_hub_client_init(&hubClient,
                                                      az_span_create((uint8_t*)endpoint.c_str(), endpoint.length()),
                                                      az_span_create((uint8_t*)deviceID.c_str(), deviceID.length()),
                                                      &hubOptions);
      if(az_result_failed(result_client)) return String("IoT Hub Client Initialization failed");

      return generateTokenCommon(&hubClient, expiry, false);
    }

    String generateTokenCommon(void* client, uint32_t expiry, bool isDPS) {
      uint8_t sigBuf[128];
      az_span sigSpan = az_span_create(sigBuf, sizeof(sigBuf));
      az_span outSig;
      az_result result_client;

      if(isDPS) {
        result_client = az_iot_provisioning_client_sas_get_signature((az_iot_provisioning_client*)client, expiry, sigSpan, &outSig); 
      } else {
        result_client = az_iot_hub_client_sas_get_signature((az_iot_hub_client*)client, expiry, sigSpan, &outSig);
      }

      if(az_result_failed(result_client)) return String("Common token generation failed");

      size_t keyLen;
      uint8_t keyBin[64];
      
      mbedtls_base64_decode(keyBin, sizeof(keyBin), &keyLen,
                            (const unsigned char*)symmetricKey.c_str(), symmetricKey.length());                             
      
      uint8_t hmac[32];
      mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256),
                      keyBin, keyLen,
                      az_span_ptr(outSig), az_span_size(outSig), 
                      hmac);

      char b64Sig[64];
      size_t b64Len;
      mbedtls_base64_encode((unsigned char*)b64Sig, sizeof(b64Sig), &b64Len, hmac, sizeof(hmac));

      char sas[200];
      size_t sasLen;

      if (isDPS) {
        result_client = az_iot_provisioning_client_sas_get_password((az_iot_provisioning_client*)client,
                                                                    az_span_create((uint8_t*)b64Sig, b64Len),
                                                                    expiry,
                                                                    AZ_SPAN_EMPTY,
                                                                    sas,
                                                                    sizeof(sas),
                                                                    &sasLen);
      } else {
        result_client = az_iot_hub_client_sas_get_password((az_iot_hub_client*)client,
                                                            expiry,
                                                            az_span_create((uint8_t*)b64Sig, b64Len),
                                                            AZ_SPAN_EMPTY,
                                                            sas,
                                                            sizeof(sas),
                                                            &sasLen);
        }
        
        if (az_result_failed(result_client)) return String("Final SAS token generation failed");
        return String(sas);
    }
};

// IoT Hub client class for telemetry
class AzureIoTHubClient {
private:
    String hubHost;
    String deviceId;
    String deviceKey;
    azureSASTokenGenerator* tokenGenerator;
    String currentToken;
    unsigned long lastTelemetryTime;
    
public:
    AzureIoTHubClient() : tokenGenerator(nullptr), lastTelemetryTime(0) {}
    
    ~AzureIoTHubClient() {
        if (tokenGenerator) {
            delete tokenGenerator;
        }
    }
    
    bool initialize(const String& host, const String& devId, const String& devKey) {
        hubHost = host;
        deviceId = devId;
        deviceKey = devKey;
        
        // Create token generator for IoT Hub
        if (tokenGenerator) {
            delete tokenGenerator;
        }
        tokenGenerator = new azureSASTokenGenerator(hubHost, deviceId, deviceKey, true);
        
        // Generate initial token
        return refreshToken();
    }
    
    bool refreshToken() {
        if (!tokenGenerator) {
            Serial.println("Token generator not initialized");
            return false;
        }
        
        uint32_t expiry = time(NULL) + 3600; // 1 hour expiry
        currentToken = tokenGenerator->generateSASToken(expiry);
        
        if (currentToken.length() == 0) {
            Serial.println("Failed to generate IoT Hub SAS token");
            return false;
        }
        
        Serial.println("IoT Hub SAS token refreshed successfully");
        return true;
    }
    
    bool sendTelemetry(const String& jsonPayload) {
        // Check if token needs refresh
        if (tokenGenerator && tokenGenerator->IsExpired()) {
            Serial.println("Token expired, refreshing...");
            if (!refreshToken()) {
                return false;
            }
        }
        
        WiFiClientSecure client;
        client.setInsecure(); // Skip certificate validation for simplicity
        
        HTTPClient http;
        
        // Build IoT Hub telemetry URL
        String url = String("https://") + hubHost + "/devices/" + deviceId + 
                     "/messages/events?api-version=2020-03-13";
        
        if (!http.begin(client, url)) {
            Serial.println("IoT Hub: HTTP begin failed");
            return false;
        }
        
        // Set headers
        http.addHeader("Authorization", currentToken);
        http.addHeader("Content-Type", "application/json");
        http.addHeader("iothub-messageid", String(millis())); // Simple message ID
        
        Serial.println("Sending telemetry to IoT Hub...");
        Serial.println("URL: " + url);
        Serial.println("Payload: " + jsonPayload);
        
        int httpCode = http.POST(jsonPayload);
        String response = http.getString();
        http.end();
        
        if (httpCode == HTTP_CODE_NO_CONTENT || httpCode == HTTP_CODE_OK) {
            Serial.printf("Telemetry sent successfully (HTTP %d)\n", httpCode);
            lastTelemetryTime = millis();
            return true;
        } else {
            Serial.printf("Telemetry failed with HTTP code: %d\n", httpCode);
            if (response.length() > 0) {
                Serial.println("Response: " + response);
            }
            return false;
        }
    }
    
    String createTelemetryPayload() {
        ArduinoJson::JsonDocument doc;
        
        // Add device information
        doc["deviceId"] = deviceId;
        doc["storeId"] = STORE_ID;
        doc["region"] = REGION;
        doc["timestamp"] = time(NULL);
        doc["firmwareVersion"] = CURRENT_FIRMWARE_VERSION;
        
        // Add device status
        // doc["wifiSignalStrength"] = WiFi.RSSI();
        doc["freeHeap"] = ESP.getFreeHeap();
        doc["uptime"] = millis() / 1000;
        
        // Add sample sensor data (replace with actual sensor readings)
        doc["temperature"] = 22.5 + (random(-50, 50) / 10.0); // Simulated temperature
        doc["humidity"] = 45.0 + (random(-100, 100) / 10.0);   // Simulated humidity
        doc["batteryLevel"] = random(85, 100);                  // Simulated battery
        
        String payload;
        serializeJson(doc, payload);
        return payload;
    }
    
    unsigned long getLastTelemetryTime() {
        return lastTelemetryTime;
    }
    
    bool isConnected() {
        return hubHost.length() > 0 && deviceId.length() > 0 && currentToken.length() > 0;
    }
};

// Global IoT Hub client instance
extern AzureIoTHubClient iotHubClient;

// Function declarations
void startAzureProvisioning();
void pollDPSAssignment();
String deriveDeviceKey(const String &enrollmentGroupKey, const String &deviceId);
void sendTelemetryIfDue();
bool initTime(const char* timezone = "UTC0");