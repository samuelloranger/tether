/// DWM wants 0x00BBGGRR.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn colorref(rgb: u32) -> u32 {
    let (r, g, b) = ((rgb >> 16) & 0xFF, (rgb >> 8) & 0xFF, rgb & 0xFF);
    (b << 16) | (g << 8) | r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colorref_is_bgr() {
        assert_eq!(colorref(0x112233), 0x332211);
    }
}
