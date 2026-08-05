#include <ApplicationServices/ApplicationServices.h>
#include <stdlib.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 3) return 2;

  CGPoint point = CGPointMake(strtod(argv[1], NULL), strtod(argv[2], NULL));
  CGEventRef down1 = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, point, kCGMouseButtonLeft);
  CGEventRef up1 = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp, point, kCGMouseButtonLeft);
  CGEventRef down2 = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, point, kCGMouseButtonLeft);
  CGEventRef up2 = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp, point, kCGMouseButtonLeft);
  if (!down1 || !up1 || !down2 || !up2) return 3;

  CGEventSetIntegerValueField(down1, kCGMouseEventClickState, 1);
  CGEventSetIntegerValueField(up1, kCGMouseEventClickState, 1);
  CGEventSetIntegerValueField(down2, kCGMouseEventClickState, 2);
  CGEventSetIntegerValueField(up2, kCGMouseEventClickState, 2);

  CGEventPost(kCGHIDEventTap, down1);
  CGEventPost(kCGHIDEventTap, up1);
  usleep(120000);
  CGEventPost(kCGHIDEventTap, down2);
  CGEventPost(kCGHIDEventTap, up2);

  CFRelease(down1);
  CFRelease(up1);
  CFRelease(down2);
  CFRelease(up2);
  return 0;
}
