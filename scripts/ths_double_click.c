#include <ApplicationServices/ApplicationServices.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 3 && argc != 4) return 2;

  CGPoint point = CGPointMake(strtod(argv[1], NULL), strtod(argv[2], NULL));
  const int singleClick = argc == 4 && strcmp(argv[3], "single") == 0;
  CGEventRef down1 = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, point, kCGMouseButtonLeft);
  CGEventRef up1 = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp, point, kCGMouseButtonLeft);
  CGEventRef down2 = singleClick ? NULL : CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, point, kCGMouseButtonLeft);
  CGEventRef up2 = singleClick ? NULL : CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp, point, kCGMouseButtonLeft);
  if (!down1 || !up1 || (!singleClick && (!down2 || !up2))) return 3;

  CGEventSetIntegerValueField(down1, kCGMouseEventClickState, 1);
  CGEventSetIntegerValueField(up1, kCGMouseEventClickState, 1);
  if (!singleClick) {
    CGEventSetIntegerValueField(down2, kCGMouseEventClickState, 2);
    CGEventSetIntegerValueField(up2, kCGMouseEventClickState, 2);
  }

  CGEventPost(kCGHIDEventTap, down1);
  CGEventPost(kCGHIDEventTap, up1);
  if (!singleClick) {
    usleep(120000);
    CGEventPost(kCGHIDEventTap, down2);
    CGEventPost(kCGHIDEventTap, up2);
  }

  CFRelease(down1);
  CFRelease(up1);
  if (!singleClick) {
    CFRelease(down2);
    CFRelease(up2);
  }
  return 0;
}
