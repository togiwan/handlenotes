# XBellek

XBellek, X’te karşılaştığın hesaplara kişisel not bırakmak için bir Chrome eklentisidir. EkşiBellek’ten uyarlanan defter, aynı X hesabıyla yeniden karşılaştığında etkin not sayısını adının başındaki düğmede gösterir. Bir hesaba birden fazla not ekleyebilir, gönderi bağlantısı saklayabilir ve notları etiketleyebilir, arşivleyebilir ya da çöp kutusuna taşıyabilirsin.

## Yerel kurulum

1. Chrome’da `chrome://extensions` adresini aç.
2. **Geliştirici modu**nu açıp **Paketlenmemiş öğe yükle**yi seç.
3. Bu projenin `extension` klasörünü seç ve açık X sekmelerini yenile.
4. X’te bir hesabın yanındaki not düğmesini veya araç çubuğundaki XBellek simgesini kullan.

## Notlarını yönet

- Not düğmesi, algılanan gönderi yazarı veya profil için defteri açar. Gönderi bağlantısı sayfadan doğrulanabildiğinde forma eklenir.
- Araç çubuğundaki **Not ekle** sekmesinde `@kullanıcıadı` yazarak bir hesap için not oluşturabilirsin.
- **Hesaplar** sekmesinden notlarını ara, geçmiş sürümleri görüntüle, arşivi ve çöp kutusunu yönet.
- **Yedekleme** sekmesinde arşiv, çöp kutusu ve geçmişi içeren bir JSON dosyası indirebilir ve daha sonra önizleyerek içe aktarabilirsin.

İlk sürüm hesapları X kullanıcı adına göre eşleştirir. Kullanıcı adı değiştiğinde eski adla kaydedilen notlar yeni ada otomatik taşınmaz. Eski ad başka bir hesaba verilirse düğme o adla saklanmış notları gösterebilir. Notları gerektiğinde **Hesaplar** sekmesinden eski adla bulabilirsin.

XBellek ayrı bir [yedek biçimi ve yerel depolama alanı](PRIVACY.md) kullanır. X’in API’sine, haricî bir sunucuya veya bir eklenti hesabına ihtiyaç duymaz. Chrome profilini silmeden veya eklentiyi kaldırmadan önce JSON yedeğini al.

## Geliştirme

Node.js ve Python 3 ile `npm test`, `npm run check` ve `npm run package` komutlarını çalıştır. Paket `dist/` altında oluşur.

XBellek, X ile bağlantısı olmayan bağımsız bir projedir. [MIT lisansı](LICENSE).
