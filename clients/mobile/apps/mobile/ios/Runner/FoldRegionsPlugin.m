#import "FoldRegionsPlugin.h"
#import <UIKit/UIKit.h>

// Keep older SDK builds working; only iOS 27.1 can supply reserved regions.
@interface FoldRegionObserver : UIView
@property(nonatomic, copy) FlutterEventSink sink;
@property(nonatomic, copy) NSDictionary *lastSnapshot;
- (void)publishRegions;
@end

@implementation FoldRegionObserver
- (instancetype)initWithFrame:(CGRect)frame {
  self = [super initWithFrame:frame];
  if (self) {
    self.userInteractionEnabled = NO;
    self.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
#if __IPHONE_OS_VERSION_MAX_ALLOWED >= 270100
    if (@available(iOS 27.1, *)) {
      __weak FoldRegionObserver *weakSelf = self;
      UIHingeInteraction *hinge = [[UIHingeInteraction alloc]
          initWithUpdateHandler:^(UIHingeInteraction *interaction, UIHingeInteractionUpdate *update) {
            // Query after UIKit has applied the corresponding scene geometry.
            [weakSelf setNeedsLayout];
          }];
      [self addInteraction:hinge];
      [self registerForTraitChanges:UITraitCollection.systemTraitsAffectingVerticalBarEdge
          withHandler:^(id<UITraitEnvironment> environment, UITraitCollection *previous) {
            [weakSelf setNeedsLayout];
          }];
    }
#endif
  }
  return self;
}

- (void)didMoveToWindow {
  [super didMoveToWindow];
  [self setNeedsLayout];
}

- (void)layoutSubviews {
  [super layoutSubviews];
  [self publishRegions];
}

- (void)safeAreaInsetsDidChange {
  [super safeAreaInsetsDidChange];
  [self setNeedsLayout];
}

static NSDictionary *RectSnapshot(CGRect frame) {
  return @{@"x": @(frame.origin.x), @"y": @(frame.origin.y),
           @"width": @(frame.size.width), @"height": @(frame.size.height)};
}

- (void)publishRegions {
  if (!self.window || !self.sink) return;
  NSMutableArray *regions = [NSMutableArray array];
  NSMutableArray *occlusions = [NSMutableArray array];
  NSString *verticalBarEdge = @"none";
#if __IPHONE_OS_VERSION_MAX_ALLOWED >= 270100
  if (@available(iOS 27.1, *)) {
    for (UIViewReservedRegion *region in
         [self reservedRegionsOfKind:UIViewReservedRegionKind.divisionRegionKind]) {
      if (!region.isActive) continue;
      // UIKit includes the interactive-content margin in this frame.
      [regions addObject:RectSnapshot(region.frame)];
    }
    for (UIViewReservedRegion *region in
         [self reservedRegionsOfKind:UIViewReservedRegionKind.occlusionRegionKind]) {
      if (region.isActive) [occlusions addObject:RectSnapshot(region.frame)];
    }
    UIVerticalBarEdge edge = self.traitCollection.verticalBarEdge;
    if (edge != UIVerticalBarEdgeUnspecified) {
      BOOL leading = edge == UIVerticalBarEdgeLeading;
      BOOL rtl = self.effectiveUserInterfaceLayoutDirection == UIUserInterfaceLayoutDirectionRightToLeft;
      verticalBarEdge = (leading != rtl) ? @"left" : @"right";
    }
  }
#endif
  NSDictionary *snapshot = @{
    @"width": @(self.bounds.size.width), @"height": @(self.bounds.size.height),
    @"regions": regions,
    @"verticalBarEdge": verticalBarEdge,
    @"occlusions": occlusions,
    @"statusBar": RectSnapshot([self convertRect:self.window.windowScene.statusBarManager.statusBarFrame
                            fromCoordinateSpace:self.window.windowScene.coordinateSpace])
  };
  if (![snapshot isEqual:self.lastSnapshot]) {
    self.lastSnapshot = snapshot;
    self.sink(snapshot);
  }
}
@end

@interface FoldRegionsPlugin () <FlutterStreamHandler>
@property(nonatomic, strong) NSObject<FlutterPluginRegistrar> *registrar;
@property(nonatomic, strong) FoldRegionObserver *observer;
@end

@implementation FoldRegionsPlugin
+ (void)registerWithRegistrar:(NSObject<FlutterPluginRegistrar> *)registrar {
  FoldRegionsPlugin *plugin = [[FoldRegionsPlugin alloc] init];
  plugin.registrar = registrar;
  FlutterEventChannel *channel = [FlutterEventChannel
      eventChannelWithName:@"com.unstoppabledomains.canopy/fold_regions"
      binaryMessenger:registrar.messenger];
  [channel setStreamHandler:plugin];
}

- (FlutterError *)onListenWithArguments:(id)arguments eventSink:(FlutterEventSink)events {
  UIView *view = self.registrar.viewController.view;
  if (!view) {
    return [FlutterError errorWithCode:@"NO_VIEW" message:@"Flutter view is unavailable" details:nil];
  }
  [self.observer removeFromSuperview];
  self.observer = [[FoldRegionObserver alloc] initWithFrame:view.bounds];
  self.observer.sink = events;
  [view addSubview:self.observer];
  [self.observer setNeedsLayout];
  return nil;
}

- (FlutterError *)onCancelWithArguments:(id)arguments {
  self.observer.sink = nil;
  [self.observer removeFromSuperview];
  self.observer = nil;
  return nil;
}
@end
