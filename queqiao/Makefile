include $(TOPDIR)/rules.mk

PKG_NAME:=queqiao
PKG_VERSION:=0.10.0
PKG_RELEASE:=4
PKG_LICENSE:=MIT
PKG_MAINTAINER:=Queqiao OpenWrt contributors

# Build the exact local checkout first with scripts/build.py. Do not silently
# fetch a different transport revision when building the feed.
QUEQIAO_BINARY ?= $(CURDIR)/../dist/queqiaod
QUEQIAO_PROFILE_BINARY ?= $(CURDIR)/../dist/queqiao-profile

include $(INCLUDE_DIR)/package.mk

define Package/queqiao
  SECTION:=net
  CATEGORY:=Network
  TITLE:=Queqiao paired WAN transport client
  URL:=https://github.com/bojieli/queqiao
  DEPENDS:=+libc
endef

define Package/queqiao/conffiles
/etc/config/queqiao
/etc/queqiao/
endef

define Build/Compile
	test -s $(QUEQIAO_BINARY)
	test -s $(QUEQIAO_PROFILE_BINARY)
endef

define Package/queqiao/install
	$(INSTALL_DIR) $(1)/usr/bin $(1)/usr/libexec $(1)/etc/init.d $(1)/etc/config $(1)/etc/queqiao
	$(INSTALL_BIN) $(QUEQIAO_BINARY) $(1)/usr/bin/queqiaod
	$(INSTALL_BIN) $(QUEQIAO_PROFILE_BINARY) $(1)/usr/libexec/queqiao-profile
	$(INSTALL_BIN) ./files/queqiao.init $(1)/etc/init.d/queqiao
	$(INSTALL_CONF) ./files/queqiao.config $(1)/etc/config/queqiao
endef

define Package/queqiao/postinst
#!/bin/sh
[ -z "$${IPKG_INSTROOT}" ] || exit 0
umask 077
mkdir -p /etc/queqiao
chmod 700 /etc/queqiao
endef

define Package/queqiao/prerm
#!/bin/sh
[ -z "$${IPKG_INSTROOT}" ] || exit 0
/etc/init.d/queqiao stop
/etc/init.d/queqiao disable
endef

$(eval $(call BuildPackage,queqiao))
