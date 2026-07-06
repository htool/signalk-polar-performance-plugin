class SI {
  /**
   * Utility class for unit conversions.
   */
  static toKnots(metersPerSecond) {
    return metersPerSecond * 1.94384;
  }

  static fromKnots(knots) {
    return knots / 1.94384;
  }

  static toDegrees(radians) {
    return radians * (180 / Math.PI);
  }

  static fromDegrees(degrees) {
    return degrees * (Math.PI / 180);
  }
}
module.exports = SI; 