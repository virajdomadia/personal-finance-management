from app.api.routes.transactions import DEFAULT_CATEGORIES
from app.sms.merchants import MERCHANT_KEYWORDS, builtin_category
from app.sms.payees import display_name, payee_key


def test_key_keeps_upi_handle():
    assert payee_key(" Swiggy@ICICI ") == "swiggy@icici"


def test_key_drops_prefixes_and_collapses_space():
    assert payee_key("VPA  Blinkit  Store") == "blinkit store"
    assert payee_key("UPI/Zepto") == "zepto"
    assert payee_key("TO Ramesh") == "ramesh"
    assert payee_key("by Ramesh") == "ramesh"


def test_display_cleans_upi():
    assert display_name("zomato.order@hdfcbank") == "Zomato Order"
    assert display_name("rahul_123@okaxis") == "Rahul"


def test_display_plain_text():
    assert display_name("  Blinkit ") == "Blinkit"
    assert display_name("XX650") == "XX650"
    assert len(display_name("a" * 100)) == 60


def test_builtin_matches_tokens():
    assert builtin_category("swiggy@icici") == "Food and dining"
    assert builtin_category("motorola store") is None
    assert builtin_category("ola@paytm") == "Transport"
    assert builtin_category("blinkit") == "Groceries"
    assert builtin_category("vi prepaid") == "Utilities"
    assert builtin_category("vivid") is None
    assert builtin_category("adani electricity ltd") == "Utilities"
    assert builtin_category("xx650") is None


def test_builtin_categories_are_defaults():
    for _, category in MERCHANT_KEYWORDS:
        assert category in DEFAULT_CATEGORIES["expense"]
