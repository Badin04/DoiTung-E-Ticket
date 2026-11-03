#include <Wire.h>
#include <LiquidCrystal_I2C.h>

// LCD 16x2 I2C address is commonly 0x27 or 0x3F
LiquidCrystal_I2C lcd(0x27, 16, 2);

struct TicketData {
  String status;
  String ticketNo;
  String name;
  String purchaseDate;
  String purchaseTime;
  String visitDate;
  String checkedInAt;
  String message;
};

TicketData currentData;
unsigned long lastSwitch = 0;
int screenIndex = 0;

String fit16(String s) {
  s.replace("\r", " ");
  s.replace("\n", " ");
  if (s.length() > 16) return s.substring(0, 16);
  while (s.length() < 16) s += " ";
  return s;
}

String getField(String line, int index) {
  int from = 0;
  for (int i = 0; i < index; i++) {
    int pos = line.indexOf('|', from);
    if (pos < 0) return "";
    from = pos + 1;
  }
  int end = line.indexOf('|', from);
  if (end < 0) end = line.length();
  return line.substring(from, end);
}

void showScreen(int idx) {
  lcd.clear();
  switch (idx) {
    case 0:
      lcd.setCursor(0, 0); lcd.print(fit16("PURCHASE DATE"));
      lcd.setCursor(0, 1); lcd.print(fit16(currentData.purchaseDate));
      break;
    case 1:
      lcd.setCursor(0, 0); lcd.print(fit16("PURCHASE TIME"));
      lcd.setCursor(0, 1); lcd.print(fit16(currentData.purchaseTime));
      break;
    case 2:
      lcd.setCursor(0, 0); lcd.print(fit16("VISIT DATE"));
      lcd.setCursor(0, 1); lcd.print(fit16(currentData.visitDate));
      break;
    case 3:
      lcd.setCursor(0, 0); lcd.print(fit16("TICKET STATUS"));
      lcd.setCursor(0, 1);
      if (currentData.status == "valid") lcd.print(fit16("VALID / USED NOW"));
      else if (currentData.status == "used") lcd.print(fit16("ALREADY USED"));
      else if (currentData.status == "wrong_date") lcd.print(fit16("WRONG DATE"));
      else if (currentData.status == "ready") lcd.print(fit16("LCD READY"));
      else lcd.print(fit16("INVALID"));
      break;
    case 4:
      lcd.setCursor(0, 0); lcd.print(fit16("TICKET NO"));
      lcd.setCursor(0, 1); lcd.print(fit16(currentData.ticketNo));
      break;
    default:
      lcd.setCursor(0, 0); lcd.print(fit16("MESSAGE"));
      lcd.setCursor(0, 1); lcd.print(fit16(currentData.message));
      break;
  }
}

void parseLine(String line) {
  line.trim();
  if (!line.startsWith("TICKET|")) return;
  currentData.status = getField(line, 1);
  currentData.ticketNo = getField(line, 2);
  currentData.name = getField(line, 3);
  currentData.purchaseDate = getField(line, 4);
  currentData.purchaseTime = getField(line, 5);
  currentData.visitDate = getField(line, 6);
  currentData.checkedInAt = getField(line, 7);
  currentData.message = getField(line, 8);
  screenIndex = 0;
  showScreen(screenIndex);
  lastSwitch = millis();
}

void setup() {
  Serial.begin(115200);
  Wire.begin(); // SDA 21, SCL 22 on most ESP32 boards
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0); lcd.print("DOITUNG TICKET ");
  lcd.setCursor(0, 1); lcd.print("LCD STARTING...");
  delay(1500);
  lcd.clear();
  lcd.setCursor(0, 0); lcd.print("WAITING FOR QR  ");
  lcd.setCursor(0, 1); lcd.print("CONNECT WEB NOW ");
}

void loop() {
  if (Serial.available()) {
    String line = Serial.readStringUntil('\n');
    parseLine(line);
  }

  if (millis() - lastSwitch > 2500) {
    lastSwitch = millis();
    screenIndex = (screenIndex + 1) % 6;
    showScreen(screenIndex);
  }
}
