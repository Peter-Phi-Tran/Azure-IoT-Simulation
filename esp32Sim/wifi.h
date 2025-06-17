// wifi.h file
#include <WiFi.h>

#include "azure_helper.h"

#define IOT_CONFIG_WIFI_SSID "Wokwi-GUEST"
#define IOT_CONFIG_WIFI_PASSWORD ""
#define WIFI_TIMEOUT 20000  // 20 seconds timeout
#define SCAN_TIMEOUT 10000  // 10 seconds scan timeout

// Clear serial input buffer
void clearSerialBuffer() {
  while (Serial.available()) {
    Serial.read();
  }
}

// Wait for serial input with timeout
bool waitForSerialInput(unsigned long timeout = 30000) {
  unsigned long startTime = millis();
  while (!Serial.available() && (millis() - startTime < timeout)) {
    delay(100);
  }
  return Serial.available();
}

// Get user input as integer with validation
int getIntegerInput(int minVal, int maxVal, bool autoRescanOnTimeout = false) {
  clearSerialBuffer();
  
  if (!waitForSerialInput()) {
    if (autoRescanOnTimeout) {
      Serial.println("Input timeout - rescanning networks...");
      return -2; // Special value to indicate timeout with rescan
    } else {
      Serial.println("Input timeout");
      return -1;
    }
  }
  
  int value = Serial.parseInt();
  clearSerialBuffer(); // Clear any remaining characters
  
  if (value < minVal || value > maxVal) {
    Serial.printf("Invalid input. Please enter a number between %d and %d\n", minVal, maxVal);
    return -1;
  }
  
  return value;
}

// Get password input
String getPasswordInput(const String &ssid) {
  Serial.printf("Enter password for '%s': ", ssid.c_str());
  clearSerialBuffer();
  
  if (!waitForSerialInput()) {
    Serial.println("\nPassword input timeout - rescanning networks...");
    return "TIMEOUT"; // Special value to indicate timeout
  }
  
  String password = Serial.readString();
  password.trim();
  clearSerialBuffer();
  
  return password;
}

bool scanAndShowNetworks() {
  // Check if already connected
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("Already connected to WiFi");
    Serial.printf("SSID: %s\n", WiFi.SSID().c_str());
    Serial.printf("IP Address: %s\n", WiFi.localIP().toString().c_str());
    Serial.printf("Signal Strength: %d dBm\n", WiFi.RSSI());
    return true;
  }

  // Disconnect and prepare for scan
  WiFi.disconnect(true);
  WiFi.mode(WIFI_STA);
  delay(100);

  Serial.println("\nScanning for WiFi networks...");
  
  // Perform scan with timeout
  unsigned long scanStart = millis();
  int numSSID = WiFi.scanNetworks();
  
  if (numSSID == -1 || (millis() - scanStart > SCAN_TIMEOUT)) {
    Serial.println("Failed to scan networks or scan timeout - will retry automatically...");
    return false;
  }

  if (numSSID == 0) {
    Serial.println("No networks found - rescanning...");
    return false;
  }

  // Display networks
  Serial.printf("\nFound %d networks:\n", numSSID);
  Serial.println("----------------------------------------------------");
  Serial.println("No. | SSID                          | Signal | Security");
  Serial.println("----------------------------------------------------");
  
  for (int i = 0; i < numSSID; i++) {
    String ssid = WiFi.SSID(i);
    int rssi = WiFi.RSSI(i);
    wifi_auth_mode_t encType = WiFi.encryptionType(i);
    
    String security;
    switch (encType) {
      case WIFI_AUTH_OPEN: security = "Open"; break;
      case WIFI_AUTH_WEP: security = "WEP"; break;
      case WIFI_AUTH_WPA_PSK: security = "WPA"; break;
      case WIFI_AUTH_WPA2_PSK: security = "WPA2"; break;
      case WIFI_AUTH_WPA_WPA2_PSK: security = "WPA/WPA2"; break;
      case WIFI_AUTH_WPA2_ENTERPRISE: security = "WPA2-ENT"; break;
      case WIFI_AUTH_WPA3_PSK: security = "WPA3"; break;
      default: security = "Unknown"; break;
    }
    
    // Truncate long SSIDs for display
    String displaySSID = ssid;
    if (displaySSID.length() > 28) {
      displaySSID = displaySSID.substring(0, 25) + "...";
    }
    
    Serial.printf("%2d  | %-28s | %4ddBm | %s\n", 
                 i+1, displaySSID.c_str(), rssi, security.c_str());
  }
  Serial.println("----------------------------------------------------");

  // Get user selection with auto-rescan on timeout
  Serial.printf("\nEnter network number (1-%d) or 0 to cancel: ", numSSID);
  
  int choice = getIntegerInput(0, numSSID, true); // Enable auto-rescan on timeout
  
  if (choice == -2) {
    // Timeout occurred, trigger rescan
    return false;
  }
  
  if (choice == -1) {
    // Invalid input, ask again
    Serial.println("Please try again...");
    delay(2000);
    return false;
  }
  
  if (choice == 0) {
    Serial.println("Selection cancelled");
    return false;
  }

  // Connect to selected network
  int networkIndex = choice - 1;
  String selectedSSID = WiFi.SSID(networkIndex);
  String password = "";

  // Get password if network is secured
  if (WiFi.encryptionType(networkIndex) != WIFI_AUTH_OPEN) {
    password = getPasswordInput(selectedSSID);
    
    if (password == "TIMEOUT") {
      // Password input timeout, trigger rescan
      return false;
    }
    
    if (password.length() == 0) {
      Serial.println("Password required for secured network - rescanning...");
      delay(2000);
      return false;
    }
  }

  // Attempt connection
  Serial.printf("Connecting to '%s'", selectedSSID.c_str());
  
  WiFi.begin(selectedSSID.c_str(), password.c_str());
  
  unsigned long startTime = millis();
  int dotCount = 0;
  
  while (WiFi.status() != WL_CONNECTED && (millis() - startTime < WIFI_TIMEOUT)) {
    delay(500);
    Serial.print(".");
    dotCount++;
    
    // Add newline every 20 dots for readability
    if (dotCount % 20 == 0) {
      Serial.println();
    }
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n✓ Connected successfully!");
    Serial.printf("SSID: %s\n", WiFi.SSID().c_str());
    Serial.printf("IP Address: %s\n", WiFi.localIP().toString().c_str());
    Serial.printf("Gateway: %s\n", WiFi.gatewayIP().toString().c_str());
    startAzureProvisioning();
    return true;
  } else {
    Serial.println("\n✗ Connection failed!");
    
    // Provide specific error information
    switch (WiFi.status()) {
      case WL_NO_SSID_AVAIL:
        Serial.println("Network not found - rescanning...");
        break;
      case WL_CONNECT_FAILED:
        Serial.println("Connection failed (wrong password?) - rescanning...");
        break;
      case WL_CONNECTION_LOST:
        Serial.println("Connection lost - rescanning...");
        break;
      case WL_DISCONNECTED:
        Serial.println("Disconnected - rescanning...");
        break;
      default:
        Serial.printf("Unknown error (status: %d) - rescanning...\n", WiFi.status());
        break;
    }
    
    delay(2000); // Brief pause before rescanning
    return false;
  }
}

void startWifiConnectionManager() {
  Serial.println("=== WiFi Connection Manager ===");
  Serial.println("Note: Timeouts will automatically trigger network rescanning");
  
  int maxRetries = 10; // Prevent infinite loops
  int retryCount = 0;
  
  while (retryCount < maxRetries) {
    if (scanAndShowNetworks()) {
      Serial.println("\nConnection established successfully!");
      return;
    }

    retryCount++;
    
    // Only show manual options if we haven't hit max retries
    if (retryCount < maxRetries) {
      Serial.println("\nConnection options:");
      Serial.println("1. Scan networks again");
      Serial.println("2. Exit connection manager");
      Serial.print("Choose option (1-2): ");
      
      int choice = getIntegerInput(1, 2, false); // Don't auto-rescan for menu choices
      
      if (choice == -1) {
        Serial.println("Invalid input or timeout - rescanning automatically...");
        delay(2000);
        continue; // Rescan automatically
      }
      
      if (choice == 2) {
        Serial.println("Exiting WiFi connection manager");
        return;
      }
      
      Serial.println("\nRefreshing network scan...");
      delay(1000); // Brief pause before rescanning
    } else {
      Serial.printf("Maximum retry attempts (%d) reached. Exiting connection manager.\n", maxRetries);
      return;
    }
  }
}

// Helper function to check WiFi status
void printWiFiStatus() {
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("WiFi Status: Connected");
    Serial.printf("SSID: %s\n", WiFi.SSID().c_str());
    Serial.printf("IP: %s\n", WiFi.localIP().toString().c_str());
    Serial.printf("Signal: %d dBm\n", WiFi.RSSI());
  } else {
    Serial.println("WiFi Status: Disconnected");
  }
}